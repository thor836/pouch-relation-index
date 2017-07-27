(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.pouchRelationIndex = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

/**
 * Stringify/parse functions that don't operate
 * recursively, so they avoid call stack exceeded
 * errors.
 */
exports.stringify = function stringify(input) {
  var queue = [];
  queue.push({obj: input});

  var res = '';
  var next, obj, prefix, val, i, arrayPrefix, keys, k, key, value, objPrefix;
  while ((next = queue.pop())) {
    obj = next.obj;
    prefix = next.prefix || '';
    val = next.val || '';
    res += prefix;
    if (val) {
      res += val;
    } else if (typeof obj !== 'object') {
      res += typeof obj === 'undefined' ? null : JSON.stringify(obj);
    } else if (obj === null) {
      res += 'null';
    } else if (Array.isArray(obj)) {
      queue.push({val: ']'});
      for (i = obj.length - 1; i >= 0; i--) {
        arrayPrefix = i === 0 ? '' : ',';
        queue.push({obj: obj[i], prefix: arrayPrefix});
      }
      queue.push({val: '['});
    } else { // object
      keys = [];
      for (k in obj) {
        if (obj.hasOwnProperty(k)) {
          keys.push(k);
        }
      }
      queue.push({val: '}'});
      for (i = keys.length - 1; i >= 0; i--) {
        key = keys[i];
        value = obj[key];
        objPrefix = (i > 0 ? ',' : '');
        objPrefix += JSON.stringify(key) + ':';
        queue.push({obj: value, prefix: objPrefix});
      }
      queue.push({val: '{'});
    }
  }
  return res;
};

// Convenience function for the parse function.
// This pop function is basically copied from
// pouchCollate.parseIndexableString
function pop(obj, stack, metaStack) {
  var lastMetaElement = metaStack[metaStack.length - 1];
  if (obj === lastMetaElement.element) {
    // popping a meta-element, e.g. an object whose value is another object
    metaStack.pop();
    lastMetaElement = metaStack[metaStack.length - 1];
  }
  var element = lastMetaElement.element;
  var lastElementIndex = lastMetaElement.index;
  if (Array.isArray(element)) {
    element.push(obj);
  } else if (lastElementIndex === stack.length - 2) { // obj with key+value
    var key = stack.pop();
    element[key] = obj;
  } else {
    stack.push(obj); // obj with key only
  }
}

exports.parse = function (str) {
  var stack = [];
  var metaStack = []; // stack for arrays and objects
  var i = 0;
  var collationIndex,parsedNum,numChar;
  var parsedString,lastCh,numConsecutiveSlashes,ch;
  var arrayElement, objElement;
  while (true) {
    collationIndex = str[i++];
    if (collationIndex === '}' ||
        collationIndex === ']' ||
        typeof collationIndex === 'undefined') {
      if (stack.length === 1) {
        return stack.pop();
      } else {
        pop(stack.pop(), stack, metaStack);
        continue;
      }
    }
    switch (collationIndex) {
      case ' ':
      case '\t':
      case '\n':
      case ':':
      case ',':
        break;
      case 'n':
        i += 3; // 'ull'
        pop(null, stack, metaStack);
        break;
      case 't':
        i += 3; // 'rue'
        pop(true, stack, metaStack);
        break;
      case 'f':
        i += 4; // 'alse'
        pop(false, stack, metaStack);
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
      case '-':
        parsedNum = '';
        i--;
        while (true) {
          numChar = str[i++];
          if (/[\d\.\-e\+]/.test(numChar)) {
            parsedNum += numChar;
          } else {
            i--;
            break;
          }
        }
        pop(parseFloat(parsedNum), stack, metaStack);
        break;
      case '"':
        parsedString = '';
        lastCh = void 0;
        numConsecutiveSlashes = 0;
        while (true) {
          ch = str[i++];
          if (ch !== '"' || (lastCh === '\\' &&
              numConsecutiveSlashes % 2 === 1)) {
            parsedString += ch;
            lastCh = ch;
            if (lastCh === '\\') {
              numConsecutiveSlashes++;
            } else {
              numConsecutiveSlashes = 0;
            }
          } else {
            break;
          }
        }
        pop(JSON.parse('"' + parsedString + '"'), stack, metaStack);
        break;
      case '[':
        arrayElement = { element: [], index: stack.length };
        stack.push(arrayElement.element);
        metaStack.push(arrayElement);
        break;
      case '{':
        objElement = { element: {}, index: stack.length };
        stack.push(objElement.element);
        metaStack.push(objElement);
        break;
      default:
        throw new Error(
          'unexpectedly reached end of input: ' + collationIndex);
    }
  }
};

},{}],2:[function(require,module,exports){
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var IndexExistsError = (function (_super) {
    __extends(IndexExistsError, _super);
    function IndexExistsError(name) {
        return _super.call(this, "Index " + name + " already exists") || this;
    }
    return IndexExistsError;
}(Error));
exports.default = IndexExistsError;

},{}],3:[function(require,module,exports){
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var IndexNotFoundError = (function (_super) {
    __extends(IndexNotFoundError, _super);
    function IndexNotFoundError(name) {
        var _this = _super.call(this, "Index " + name + " could not be found") || this;
        _this.status = 404;
        return _this;
    }
    return IndexNotFoundError;
}(Error));
exports.default = IndexNotFoundError;

},{}],4:[function(require,module,exports){
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var SelectorError = (function (_super) {
    __extends(SelectorError, _super);
    function SelectorError() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    return SelectorError;
}(Error));
exports.default = SelectorError;

},{}],5:[function(require,module,exports){
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var webSqlProvider_1 = require("./webSqlProvider");
var SqliteProvider = (function (_super) {
    __extends(SqliteProvider, _super);
    function SqliteProvider() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    SqliteProvider.prototype.batchSql = function (batch) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            var conn = _this.openConnection();
            if (typeof conn.sqlBatch === 'function') {
                conn.sqlBatch(batch, resolve, reject);
            }
            else {
                _super.prototype.batchSql.call(_this, batch).then(resolve).catch(reject);
            }
        });
    };
    SqliteProvider.prototype.openConnection = function () {
        return window['sqlitePlugin'].openDatabase({
            name: this.db,
            location: 'default',
            androidDatabaseImplementation: 2,
            version: 1,
            description: this.db,
            size: 5000000
        });
    };
    return SqliteProvider;
}(webSqlProvider_1.default));
exports.default = SqliteProvider;

},{"./webSqlProvider":6}],6:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var utils_1 = require("../utils");
var WebSqlProvider = (function () {
    function WebSqlProvider(db, openDatabase) {
        this.db = db;
        this.openDatabase = openDatabase;
    }
    WebSqlProvider.prototype.executeSql = function (sql, args) {
        var _this = this;
        if (args === void 0) { args = []; }
        return new Promise(function (resolve, reject) {
            var conn = _this.openConnection();
            conn.transaction(function (tx) {
                return tx.executeSql(sql, args || [], function (tx, res) { return resolve(res); }, function (tx, e) {
                    reject(e);
                    return true;
                });
            }, function (e) { return reject(e); });
        });
    };
    WebSqlProvider.prototype.batchSql = function (batch) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            var conn = _this.openConnection();
            conn.transaction(function (tx) {
                return utils_1.default.eachAsync(batch, function (item, next) {
                    tx.executeSql(item[0], item[1], function () { return next(); }, function (tx, e) { return next(e); });
                }, function (e) { return !e ? resolve() : reject(e); });
            }, function (e) { return reject(e); });
        });
    };
    WebSqlProvider.prototype.openConnection = function () {
        return this.openDatabase ?
            this.openDatabase(this.db) :
            window['openDatabase'](this.db, '1', '', 5000000);
    };
    return WebSqlProvider;
}());
exports.default = WebSqlProvider;

},{"../utils":9}],7:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var utils_1 = require("./utils");
var selectorError_1 = require("./errors/selectorError");
var QueryBuilder = (function () {
    function QueryBuilder() {
    }
    QueryBuilder.query = function (selector, table) {
        var args = [];
        var str = QueryBuilder.parseObject(selector, table, args);
        return { where: str, args: args };
    };
    QueryBuilder.parseObject = function (obj, tableName, args) {
        var result = [];
        for (var key in obj)
            if (obj.hasOwnProperty(key)) {
                var val = obj[key];
                if (['$or', '$and'].indexOf(key) > -1 && !Array.isArray(val))
                    throw new selectorError_1.default("Use of $and, $or operator requires an array as its parameter.");
                result.length && result.push(' AND ');
                switch (key) {
                    case '$or':
                        var s = val.map(function (item) { return QueryBuilder.parseObject(item, tableName, args); });
                        s.length && result.push("(" + s.join(' OR ') + ")");
                        break;
                    case '$and':
                        s = val.map(function (item) { return QueryBuilder.parseObject(item, tableName, args); });
                        s.length && result.push("(" + s.join(' AND ') + ")");
                        break;
                    default:
                        result.push(QueryBuilder.parseSingleKeyValue(key, val, tableName, args));
                        break;
                }
            }
        return result.join('');
    };
    QueryBuilder.parseSingleKeyValue = function (key, val, tableName, args) {
        var op = QueryBuilder.operators[key] || (typeof val !== 'object' ? QueryBuilder.operators['$eq'] : null);
        if (op) {
            if (key == '$in' || key == '$nin') {
                if (!Array.isArray(val))
                    throw new selectorError_1.default("Use of $in, $nin operator requires an array as its parameter.");
                args.concat(val);
                return op + " [" + Array(val.length).fill('?').join() + "]";
            }
            else {
                QueryBuilder.operators[key] == null && (op = utils_1.default.wrap(tableName) + "." + utils_1.default.wrap(key) + " " + op);
                args.push(typeof val === 'string' ? val.toLowerCase() : val);
                return op + " ?";
            }
        }
        return utils_1.default.wrap(tableName) + "." + utils_1.default.wrap(key) + " " + QueryBuilder.parseObject(val, tableName, args);
    };
    return QueryBuilder;
}());
QueryBuilder.operators = {
    '$eq': '=',
    '$lt': '<',
    '$gt': '>',
    '$lte': '<=',
    '$gte': '>=',
    '$ne': '!=',
    '$in': 'IN',
    '$nin': 'NOT IN',
    '$like': 'LIKE'
};
exports.default = QueryBuilder;

},{"./errors/selectorError":4,"./utils":9}],8:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var indexNotFoundError_1 = require("./errors/indexNotFoundError");
var utils_1 = require("./utils");
var indexExistsError_1 = require("./errors/indexExistsError");
var sqliteProvider_1 = require("./providers/sqliteProvider");
var webSqlProvider_1 = require("./providers/webSqlProvider");
var queryBuilder_1 = require("./queryBuilder");
var INDEX_TABLE = 'relation-indexes';
var INDEX_PREFIX = '_ri_';
var RelationIndex = (function () {
    function RelationIndex(db, provider) {
        this.db = db;
        this.provider = provider;
        this._init = false;
        this.indexes = {};
    }
    RelationIndex.prototype.info = function (name) {
        var index = this.indexes[name];
        return index ? Promise.resolve(index) : Promise.reject(new indexNotFoundError_1.default(name));
    };
    RelationIndex.prototype.create = function (options) {
        var _this = this;
        if (this.indexes[options.name])
            return Promise.reject(new indexExistsError_1.default(options.name));
        var fields = options.fields.map(function (f) {
            return { name: f.name || (f + ''), type: f.type || '' };
        });
        var internalFields = [{ name: 'id', primary_key: true },
            { name: 'rev' }]
            .concat(fields);
        return this.createTable("" + INDEX_PREFIX + options.name, internalFields)
            .then(function () { return _this.provider.executeSql("INSERT INTO " + utils_1.default.wrap(INDEX_TABLE) + " VALUES (?,?,?)", [options.name, options.doc_type, JSON.stringify(fields)]); })
            .then(function () {
            _this.indexes[options.name] = Object.assign({}, options, { fields: fields });
        });
    };
    RelationIndex.prototype.build = function (name) {
        var _this = this;
        var index = this.indexes[name];
        if (!index)
            return Promise.reject(new indexNotFoundError_1.default(name));
        var tbl = utils_1.default.wrap("" + INDEX_PREFIX + name);
        return this.provider.executeSql("DELETE FROM " + tbl)
            .then(function () { return _this.fillIndexTable(index); });
    };
    RelationIndex.prototype.query = function (name, options) {
        var index = this.indexes[name];
        if (!index)
            return Promise.reject(new indexNotFoundError_1.default(name));
        var tbl = utils_1.default.wrap("" + INDEX_PREFIX + name);
        var q = options.selector ? queryBuilder_1.default.query(options.selector, "" + INDEX_PREFIX + name) : null;
        var orderBy = options.order && options.order.length ? options.order.map(function (o) { return tbl + "." + utils_1.default.wrap(o.field || (o + '')) + " " + (o.dir || 'ASC'); }).join() : '';
        var sql;
        if (options.include_docs != false)
            sql = "\n            SELECT\n                `document-store`.id AS id,\n                `by-sequence`.rev AS rev,\n                `by-sequence`.json AS data \n            FROM `document-store` \n                JOIN `by-sequence` ON `by-sequence`.seq = `document-store`.winningseq \n                JOIN " + tbl + " ON `document-store`.id = " + tbl + ".id \n            WHERE \n                " + (q.where ? q.where + ' AND ' : '') + " \n                `by-sequence`.deleted = 0 \n            ORDER BY " + (orderBy ? orderBy + ',' : '') + " `document-store`.id ASC";
        else {
            var flds = index.fields.map(function (f) { return tbl + utils_1.default.wrap(f.name); });
            sql = "SELECT " + flds.join() + " FROM " + tbl + " WHERE " + (q.where ? q.where + ' AND ' : '') + " 1 = 1 " + (orderBy ? 'ORDER BY ' + orderBy + ',' : '');
        }
        sql = sql + " " + (options.limit ? 'LIMIT ' + options.limit : '') + " " + (options.start ? 'OFFSET ' + options.start : '');
        return this.provider.executeSql(sql, q.args)
            .then(function (res) {
            var docs = [];
            for (var i = 0; i < res.rows.length; i++) {
                var row = res.rows.item(i);
                docs.push(utils_1.default.unstringifyDoc(row.data, row.id, row.rev));
            }
            return docs;
        });
    };
    RelationIndex.prototype.remove = function (name) {
        var _this = this;
        var index = this.indexes[name];
        if (!index)
            return Promise.reject(new indexNotFoundError_1.default(name));
        var tbl = utils_1.default.wrap("" + INDEX_PREFIX + name);
        return this.provider.executeSql("DELETE FROM " + utils_1.default.wrap(INDEX_TABLE) + " WHERE index_name = ?", [name])
            .then(function () { return _this.provider.executeSql("DROP TABLE IF EXISTS " + tbl); })
            .then(function () {
            delete _this.indexes[name];
        });
    };
    RelationIndex.prototype.update = function (name) {
        var _this = this;
        var index = this.indexes[name];
        if (!index)
            return Promise.reject(new indexNotFoundError_1.default(name));
        var tbl = utils_1.default.wrap("" + INDEX_PREFIX + name);
        var docTypeLen = index.doc_type.length;
        var fields = ['_id', '_rev'].concat(index.fields.map(function (f) { return f.name; }));
        var p = Array(fields.length).fill('?');
        var sql = "\n        SELECT \n            `document-store`.id AS id, \n            `by-sequence`.rev AS rev, \n            `by-sequence`.json AS data \n        FROM `document-store` \n            JOIN `by-sequence` ON `by-sequence`.seq = `document-store`.winningseq  \n        WHERE \n            NOT EXISTS(SELECT 1 FROM " + tbl + " WHERE `document-store`.id like " + tbl + ".id )  \n            AND \n            substr(`document-store`.id, 1, " + docTypeLen + ") = ?  \n            AND \n            `by-sequence`.deleted = 0";
        return this.provider.executeSql(sql, [index.doc_type])
            .then(function (res) {
            var docs = [];
            for (var i = 0; i < res.rows.length; i++) {
                var row = res.rows.item(i);
                docs.push(utils_1.default.unstringifyDoc(row.data, row.id, row.rev));
            }
            if (!docs.length)
                return;
            var sqlStatements = docs.map(function (r) {
                var args = fields.map(function (f) {
                    var v = utils_1.default.resolve(r, f);
                    return typeof v === 'string' ? v.toLowerCase() : v;
                });
                return ["INSERT INTO " + tbl + " VALUES (" + p + ")", args];
            });
            return _this.provider.batchSql(sqlStatements);
        });
    };
    RelationIndex.prototype.init = function () {
        var _this = this;
        if (this._init)
            return Promise.resolve(null);
        return this.createTable(INDEX_TABLE, [
            { name: 'index_name', type: 'TEXT' },
            { name: 'doc_type', type: 'TEXT' },
            { name: 'json', type: 'TEXT' }
        ])
            .then(function () { return _this.getIndexes(); })
            .then(function () {
            _this._init = true;
        });
    };
    RelationIndex.prototype.getIndexes = function () {
        var _this = this;
        return this.provider.executeSql("SELECT * FROM " + utils_1.default.wrap(INDEX_TABLE))
            .then(function (rs) {
            for (var i = 0; i < rs.rows.length; i++) {
                var row = rs.rows.item(i);
                _this.indexes[row.index_name] = {
                    name: row.index_name,
                    doc_type: row.doc_type,
                    fields: JSON.parse(row.json)
                };
            }
        });
    };
    RelationIndex.prototype.createTable = function (name, fields) {
        return this.provider.executeSql("CREATE TABLE IF NOT EXISTS " + utils_1.default.wrap(name) + " (" + utils_1.default.fieldsToSql(fields) + ")")
            .then(function () {
        });
    };
    RelationIndex.prototype.fillIndexTable = function (index, start) {
        var _this = this;
        if (start === void 0) { start = 0; }
        var limit = 1000;
        var tbl = utils_1.default.wrap("" + INDEX_PREFIX + index.name);
        var fields = ['_id', '_rev'].concat(index.fields.map(function (f) { return f.name; }));
        var p = Array(fields.length).fill('?');
        return this.db.allDocs({
            startkey: index.doc_type,
            endkey: index.doc_type + "\uFFFF",
            include_docs: true,
            skip: start,
            limit: limit
        })
            .then(function (res) {
            var len = res.rows.length;
            if (!len)
                return;
            var sqlStatements = res.rows.map(function (r) {
                var args = fields.map(function (f) {
                    var v = utils_1.default.resolve(r.doc, f);
                    return typeof v === 'string' ? v.toLowerCase() : v;
                });
                return ["INSERT INTO " + tbl + " VALUES (" + p + ")", args];
            });
            return _this.provider.batchSql(sqlStatements)
                .then(function () {
                if (len === limit)
                    return _this.fillIndexTable(index, start + limit);
            });
        });
    };
    RelationIndex.instance = function (db, openDatabase) {
        if (db.relIndex)
            return Promise.resolve(null);
        var provider;
        if (db.adapter === 'cordova-sqlite' && window['sqlitePlugin'])
            provider = new sqliteProvider_1.default(db.name);
        else if (db.adapter === 'websql')
            provider = new webSqlProvider_1.default(db.prefix + db.name, openDatabase);
        else
            throw new Error('Relation Index plugin supports only websql or cordova-sqlite adapters');
        db.relIndex = new RelationIndex(db, provider);
        return db.relIndex.init();
    };
    return RelationIndex;
}());
exports.RelationIndex = RelationIndex;
function initRelationIndex(openDatabase) {
    var db = this;
    return RelationIndex.instance(db, openDatabase);
}
exports.initRelationIndex = initRelationIndex;
/* istanbul ignore next */
if (typeof window !== 'undefined' && !!window['PouchDB']) {
    window['PouchDB'].plugin({
        initRelationIndex: initRelationIndex
    });
}

},{"./errors/indexExistsError":2,"./errors/indexNotFoundError":3,"./providers/sqliteProvider":5,"./providers/webSqlProvider":6,"./queryBuilder":7,"./utils":9}],9:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var vuvuzela_1 = require("vuvuzela");
var Utils = (function () {
    function Utils() {
    }
    Utils.wrap = function (op) {
        if (Array.isArray(op)) {
            return op.map(function (f) { return '`' + f + '`'; }).join();
        }
        else {
            return "`" + op + "`";
        }
    };
    Utils.fieldsToSql = function (fields) {
        return fields.map(function (f) { return Utils.wrap(f.name) + " " + f.type + " " + (f.primary_key ? 'NOT NULL PRIMARY KEY' : ''); }).join();
    };
    Utils.resolve = function (obj, path, defValue) {
        if (defValue === void 0) { defValue = null; }
        return path.split(".").reduce(function (o, p) { return o && o[p]; }, obj) || defValue;
    };
    Utils.eachAsync = function (data, iterator, callback) {
        var index = 0;
        var len = data.length;
        var next = function (e) {
            if (!e && index < len) {
                iterator(data[index], next);
                index++;
            }
            else {
                typeof callback === 'function' && callback(e);
            }
        };
        next();
    };
    Utils.unstringifyDoc = function (doc, id, rev) {
        doc = Utils.safeJsonParse(doc);
        doc._id = id;
        doc._rev = rev;
        return doc;
    };
    Utils.safeJsonParse = function (str) {
        try {
            return JSON.parse(str);
        }
        catch (e) {
            /* istanbul ignore next */
            return vuvuzela_1.default.parse(str);
        }
    };
    return Utils;
}());
exports.default = Utils;

},{"vuvuzela":1}]},{},[8])(8)
});