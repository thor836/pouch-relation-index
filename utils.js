'use strict';

var vuvuzela = require('vuvuzela');

function getSize() {
    var isAndroid = typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent);
    return isAndroid ? 5000000 : 1;
}

/* global cordova, sqlitePlugin, openDatabase */
exports.openDB = function (name) {
    var size = getSize();
    var version = 1;
    if (typeof sqlitePlugin !== 'undefined') {
        return sqlitePlugin.openDatabase({
            name: name,
            version: version,
            description: '',
            size: size
        });
    }
    return openDatabase(name, version, '', size);
};

var getFields = exports.getFields = function (fields) {
    return fields.map(function (f) {
        var r = typeof f === 'string' ? {name: f, type: 'TEXT'} : f;
        r.type = (r.type || 'TEXT').toUpperCase();
        return r;
    });
};

exports.wrapFields = function (fields, tableName) {
    var wt = wrapTableName(tableName);
    return getFields(fields).map(function (f) {
        return wt + '.`' + f.name + '`';
    })
};

exports.wrapField = function (field, tableName) {
    return wrapTableName(tableName) + '.`' + field + '`';
};

var wrapTableName = exports.wrapTableName = function (tableName) {
    return tableName ? '`' + tableName + '`' : '';
};

exports.resolve = function (obj, path, defValue) {
    var rv = path.split(".").reduce(function (o, p) {
        return o && o[p];
    }, obj);
    return rv || defValue;
};

exports.eachAsync = function (data, iterator, callback) {
    var index = 0;
    var len = data.length;
    var next = function (e) {
        if (!e && index < len) {
            iterator(data[index], next);
            index++;
        } else {
            typeof callback === 'function' && callback(e);
        }
    };
    next();
};

exports.unstringifyDoc = function (doc, id, rev) {
    doc = safeJsonParse(doc);
    doc._id = id;
    doc._rev = rev;
    return doc;
};

function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        /* istanbul ignore next */
        return vuvuzela.parse(str);
    }
}