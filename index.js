var queryBuilder = require('./query-builder.js');
var utils = require('./utils');
var Promise = require('lie');

function NotFoundIndexError() {
    this.message = 'Index could not be found';
}
NotFoundIndexError.prototype = Error.prototype;
NotFoundIndexError.prototype.constructor = NotFoundIndexError;

function IndexExistsError(name) {
    this.message = 'Index with name \'' + name + '\' already exists and can not be created again;';
}
IndexExistsError.prototype = Error.prototype;
IndexExistsError.prototype.constructor = IndexExistsError;

var OPENDB;

/**
 * Create index table
 * @param name Index name
 * @param type Documents type
 * @param fields Indexed fields
 */
function createIndex(name, type, fields) {
    var db = OPENDB(this._name);
    fields = utils.getFields(fields);
    var json = JSON.stringify(fields);
    var c = checkCompatibility(this);
    if (c)
        return Promise.reject(c);

    return initRelIndex(db)
        .then(function () {
            return getIndexInfo(db, name)
                .then(function () {
                    return Promise.reject(new IndexExistsError(name))
                })
                .catch(function (e) {
                    if (!(e instanceof NotFoundIndexError))
                        return Promise.reject(e);
                });
        })
        .then(function () {
            return executeSql(db, "INSERT INTO 'relation-indexes' VALUES (?,?,?)", [name, type, json]);
        })
        .then(function () {
            var tableName = '_ri_' + name;
            return createTable(db, tableName, utils.getFields(['id', 'rev'].concat(fields)));
        });
}

/**
 * Build index
 * @param name Index name
 */
function buildIndex(name) {
    var db = OPENDB(this._name);
    var pouch = this;
    var c = checkCompatibility(this);
    if (c)
        return Promise.reject(c);

    return getIndexInfo(db, name)
        .then(function (info) {
            return executeSql(db, 'DELETE FROM ' + utils.wrapTableName('_ri_' + info.index_name))
                .then(function () {
                    return info;
                });
        })
        .then(function (info) {
            return fillIndexTable(pouch, db, info);
        });
}

/**
 * Query specified index to find some documents
 * @param name {string} Index name
 * @param query {{}} MongoDB like selector
 * @param order {{field_name: 'ASC|DESC'}} Ordering
 */
function queryIndex(name, query, order) {
    var c = checkCompatibility(this);
    if (c)
        return Promise.reject(c);

    var db = OPENDB(this._name);
    return getIndexInfo(db, name)
        .then(function (info) {
            var tableName = '_ri_' + name;
            var q = query ? queryBuilder.query(query, tableName) : null;
            var where = q ? q.query : '';
            var args = q ? q.args : [];
            where && (where = where + ' AND ');

            var orderBy = order ?
                Object.keys(order).map(function (o) {
                    return utils.wrapField(o, tableName) + ' ' + order[o].toUpperCase()
                }).join() : '';
            orderBy && (orderBy = orderBy + ',');

            var sql = 'SELECT `by-sequence`.seq AS seq, `by-sequence`.deleted AS deleted, `by-sequence`.json AS data, `by-sequence`.rev AS rev, `document-store`.id AS id, `document-store`.json AS metadata \nFROM `document-store` \nJOIN `by-sequence` ON `by-sequence`.seq = `document-store`.winningseq \nJOIN `_ri_' + name + '` ON `document-store`.id = `_ri_' + name + '`.id\nWHERE ' + where + '`by-sequence`.deleted = 0 ORDER BY ' + orderBy + ' `document-store`.id ASC';
            return executeSql(db, sql, args);
        })
        .then(function (res) {
            var docs = [];
            for (var i = 0; i < res.rows.length; i++) {
                var row = res.rows.item(i);
                docs.push(utils.unstringifyDoc(row.data, row.id, row.rev));
            }
            return docs;
        });
}

/**
 * Delete specified index
 * @param name Index name
 */
function deleteIndex(name) {
    var c = checkCompatibility(this);
    if (c)
        return Promise.reject(c);

    var db = OPENDB(this._name);
    return Promise.all([
        executeSql(db, 'DELETE FROM \'relation-indexes\' WHERE index_name = ?', [name]),
        executeSql(db, 'DROP TABLE IF EXISTS `_ri_' + name + '`')]);
}

/**
 * Fast refresh index. Adds a new documents to index table
 * @param name Index name
 */
function refreshIndex(name) {
    var c = checkCompatibility(this);
    if (c)
        return Promise.reject(c);
    var db = OPENDB(this._name);

    return getIndexInfo(db, name)
        .then(function (indexInfo) {
            docTypeLen = indexInfo.doc_type.length;
            var sql = 'SELECT `by-sequence`.seq AS seq, `by-sequence`.deleted AS deleted, `by-sequence`.json AS data, `by-sequence`.rev AS rev, `document-store`.id AS id, `document-store`.json AS metadata \nFROM `document-store` \nJOIN `by-sequence` ON `by-sequence`.seq = `document-store`.winningseq \nWHERE NOT EXISTS(SELECT 1 FROM `_ri_' + name + '` WHERE `document-store`.id = `_ri_' + name + '`.id ) AND substr(`document-store`.id, 1, ' + docTypeLen + ') = ? AND`by-sequence`.deleted = 0';
            return executeSql(db, sql, [indexInfo.doc_type])
                .then(function (res) {
                    var docs = [];
                    for (var i = 0; i < res.rows.length; i++) {
                        var row = res.rows.item(i);
                        docs.push(utils.unstringifyDoc(row.data, row.id, row.rev));
                    }
                    if (!docs.length)
                        return;

                    var tb = utils.wrapTableName('_ri_' + indexInfo.index_name);
                    var fields = utils.getFields(['_id', '_rev'].concat(indexInfo.fields));
                    var sqlStatements = docs.map(function (doc) {
                        var p = [];
                        var args = fields.map(function (f) {
                            p.push('?');
                            return utils.resolve(doc, f.name, null);
                        });
                        return ['INSERT INTO ' + tb + ' VALUES (' + p.join() + ')', args];
                    });
                    console.log(sqlStatements);
                    return batchInsert(db, sqlStatements);
                });
        })
}

function fillIndexTable(pouch, db, indexInfo, start) {
    var limit = 1000;
    start = start || 0;
    return pouch.allDocs({
        startkey: indexInfo.doc_type,
        endkey: indexInfo.doc_type + '\uFFFF',
        include_docs: true,
        skip: start,
        limit: limit
    })
        .then(function (res) {
            var len = res.rows.length;
            if (!len)
                return;
            var tb = utils.wrapTableName('_ri_' + indexInfo.index_name);
            var fields = utils.getFields(['_id', '_rev'].concat(indexInfo.fields));
            var sqlStatements = res.rows.map(function (r) {
                var p = [];
                var args = fields.map(function (f) {
                    p.push('?');
                    return utils.resolve(r.doc, f.name, null);
                });
                return ['INSERT INTO ' + tb + ' VALUES (' + p.join() + ')', args];
            });
            return batchInsert(db, sqlStatements)
                .then(function () {
                    if (len === 1000)
                        return fillIndexTable(pouch, db, indexInfo, start + limit);
                });
        });
}

function batchInsert(db, sqlStatements) {
    return new Promise(function (resolve, reject) {
        if (typeof db.sqlBatch === 'function')
            db.sqlBatch(sqlStatements,
                function () {
                    return resolve();
                }, reject);
        else {
            db.transaction(function (tx) {
                utils.eachAsync(sqlStatements,
                    function (item, next) {
                        tx.executeSql(item[0], item[1], function () {
                            next();
                        }, function (tx, e) {
                            next(e);
                        });
                    }, function (e) {
                        !e ? resolve() : reject(e);
                    });
            }, function (e) {
                !e ? resolve() : reject(e);
            });
        }
    });
}

function checkCompatibility(pouch) {
    if (pouch.adapter !== 'websql' && pouch.adapter !== 'cordova-sqlite')
        return new Error('Relation Index plugin support only websql or cordova-sqlite adapters');
}

function initRelIndex(db) {
    return createTable(db, 'relation-indexes', [
        {
            name: 'index_name',
            type: 'TEXT'
        }, {
            name: 'doc_type',
            type: 'TEXT'
        }, {
            name: 'json',
            type: 'TEXT'
        }]);
}

function createTable(db, table, fields) {
    var fieldsSql = fields
        .map(function (f) {
            return '`' + f.name + '` ' + f.type;
        })
        .join();
    return executeSql(db, 'CREATE TABLE IF NOT EXISTS \'' + table + '\' (' + fieldsSql + ')')
        .then(function () {
        });
}

function executeSql(db, sql, args) {
    return new Promise(function (resolve, reject) {
        db.transaction(function (tx) {
            tx.executeSql(sql, args || [], function (tx, res) {
                resolve(res);
            }, function (tx, e) {
                reject(e);
            });
        }, function (e) {
            reject(e);
        });
    });
}

function getIndexInfo(db, name) {
    return executeSql(db, 'SELECT * FROM \'relation-indexes\' WHERE index_name = ?', [name])
        .then(function (rs) {
            if (!rs.rows.length) {
                return Promise.reject(new IndexExistsError(name));
            }
            var row = rs.rows.item(0);
            var fields = JSON.parse(row.json);
            return {
                index_name: row.index_name,
                doc_type: row.doc_type,
                fields: fields
            };
        });
}

exports.init = function (openDbFn) {
    OPENDB = openDbFn;
    return {
        createIndex: createIndex,
        buildIndex: buildIndex,
        queryIndex: queryIndex,
        deleteIndex: deleteIndex,
        refreshIndex: refreshIndex
    };
};