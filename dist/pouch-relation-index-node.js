(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
var queryBuilder = _dereq_('./query-builder.js');
var utils = _dereq_('./utils');
var Promise = _dereq_('lie');

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
},{"./query-builder.js":107,"./utils":108,"lie":16}],2:[function(_dereq_,module,exports){
var openDb = _dereq_('./open-database-node');
exports = _dereq_('./index').init(openDb.open);

},{"./index":1,"./open-database-node":106}],3:[function(_dereq_,module,exports){
// http://wiki.commonjs.org/wiki/Unit_Testing/1.0
//
// THIS IS NOT TESTED NOR LIKELY TO WORK OUTSIDE V8!
//
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// when used in node, this will actually load the util module we depend on
// versus loading the builtin util module as happens otherwise
// this is a bug in node module loading as far as I am concerned
var util = _dereq_('util/');

var pSlice = Array.prototype.slice;
var hasOwn = Object.prototype.hasOwnProperty;

// 1. The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

var assert = module.exports = ok;

// 2. The AssertionError is defined in assert.
// new assert.AssertionError({ message: message,
//                             actual: actual,
//                             expected: expected })

assert.AssertionError = function AssertionError(options) {
  this.name = 'AssertionError';
  this.actual = options.actual;
  this.expected = options.expected;
  this.operator = options.operator;
  if (options.message) {
    this.message = options.message;
    this.generatedMessage = false;
  } else {
    this.message = getMessage(this);
    this.generatedMessage = true;
  }
  var stackStartFunction = options.stackStartFunction || fail;

  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, stackStartFunction);
  }
  else {
    // non v8 browsers so we can have a stacktrace
    var err = new Error();
    if (err.stack) {
      var out = err.stack;

      // try to strip useless frames
      var fn_name = stackStartFunction.name;
      var idx = out.indexOf('\n' + fn_name);
      if (idx >= 0) {
        // once we have located the function frame
        // we need to strip out everything before it (and its line)
        var next_line = out.indexOf('\n', idx + 1);
        out = out.substring(next_line + 1);
      }

      this.stack = out;
    }
  }
};

// assert.AssertionError instanceof Error
util.inherits(assert.AssertionError, Error);

function replacer(key, value) {
  if (util.isUndefined(value)) {
    return '' + value;
  }
  if (util.isNumber(value) && !isFinite(value)) {
    return value.toString();
  }
  if (util.isFunction(value) || util.isRegExp(value)) {
    return value.toString();
  }
  return value;
}

function truncate(s, n) {
  if (util.isString(s)) {
    return s.length < n ? s : s.slice(0, n);
  } else {
    return s;
  }
}

function getMessage(self) {
  return truncate(JSON.stringify(self.actual, replacer), 128) + ' ' +
         self.operator + ' ' +
         truncate(JSON.stringify(self.expected, replacer), 128);
}

// At present only the three keys mentioned above are used and
// understood by the spec. Implementations or sub modules can pass
// other keys to the AssertionError's constructor - they will be
// ignored.

// 3. All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided.  All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

function fail(actual, expected, message, operator, stackStartFunction) {
  throw new assert.AssertionError({
    message: message,
    actual: actual,
    expected: expected,
    operator: operator,
    stackStartFunction: stackStartFunction
  });
}

// EXTENSION! allows for well behaved errors defined elsewhere.
assert.fail = fail;

// 4. Pure assertion tests whether a value is truthy, as determined
// by !!guard.
// assert.ok(guard, message_opt);
// This statement is equivalent to assert.equal(true, !!guard,
// message_opt);. To test strictly for the value true, use
// assert.strictEqual(true, guard, message_opt);.

function ok(value, message) {
  if (!value) fail(value, true, message, '==', assert.ok);
}
assert.ok = ok;

// 5. The equality assertion tests shallow, coercive equality with
// ==.
// assert.equal(actual, expected, message_opt);

assert.equal = function equal(actual, expected, message) {
  if (actual != expected) fail(actual, expected, message, '==', assert.equal);
};

// 6. The non-equality assertion tests for whether two objects are not equal
// with != assert.notEqual(actual, expected, message_opt);

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual == expected) {
    fail(actual, expected, message, '!=', assert.notEqual);
  }
};

// 7. The equivalence assertion tests a deep equality relation.
// assert.deepEqual(actual, expected, message_opt);

assert.deepEqual = function deepEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected)) {
    fail(actual, expected, message, 'deepEqual', assert.deepEqual);
  }
};

function _deepEqual(actual, expected) {
  // 7.1. All identical values are equivalent, as determined by ===.
  if (actual === expected) {
    return true;

  } else if (util.isBuffer(actual) && util.isBuffer(expected)) {
    if (actual.length != expected.length) return false;

    for (var i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) return false;
    }

    return true;

  // 7.2. If the expected value is a Date object, the actual value is
  // equivalent if it is also a Date object that refers to the same time.
  } else if (util.isDate(actual) && util.isDate(expected)) {
    return actual.getTime() === expected.getTime();

  // 7.3 If the expected value is a RegExp object, the actual value is
  // equivalent if it is also a RegExp object with the same source and
  // properties (`global`, `multiline`, `lastIndex`, `ignoreCase`).
  } else if (util.isRegExp(actual) && util.isRegExp(expected)) {
    return actual.source === expected.source &&
           actual.global === expected.global &&
           actual.multiline === expected.multiline &&
           actual.lastIndex === expected.lastIndex &&
           actual.ignoreCase === expected.ignoreCase;

  // 7.4. Other pairs that do not both pass typeof value == 'object',
  // equivalence is determined by ==.
  } else if (!util.isObject(actual) && !util.isObject(expected)) {
    return actual == expected;

  // 7.5 For all other Object pairs, including Array objects, equivalence is
  // determined by having the same number of owned properties (as verified
  // with Object.prototype.hasOwnProperty.call), the same set of keys
  // (although not necessarily the same order), equivalent values for every
  // corresponding key, and an identical 'prototype' property. Note: this
  // accounts for both named and indexed properties on Arrays.
  } else {
    return objEquiv(actual, expected);
  }
}

function isArguments(object) {
  return Object.prototype.toString.call(object) == '[object Arguments]';
}

function objEquiv(a, b) {
  if (util.isNullOrUndefined(a) || util.isNullOrUndefined(b))
    return false;
  // an identical 'prototype' property.
  if (a.prototype !== b.prototype) return false;
  // if one is a primitive, the other must be same
  if (util.isPrimitive(a) || util.isPrimitive(b)) {
    return a === b;
  }
  var aIsArgs = isArguments(a),
      bIsArgs = isArguments(b);
  if ((aIsArgs && !bIsArgs) || (!aIsArgs && bIsArgs))
    return false;
  if (aIsArgs) {
    a = pSlice.call(a);
    b = pSlice.call(b);
    return _deepEqual(a, b);
  }
  var ka = objectKeys(a),
      kb = objectKeys(b),
      key, i;
  // having the same number of owned properties (keys incorporates
  // hasOwnProperty)
  if (ka.length != kb.length)
    return false;
  //the same set of keys (although not necessarily the same order),
  ka.sort();
  kb.sort();
  //~~~cheap key test
  for (i = ka.length - 1; i >= 0; i--) {
    if (ka[i] != kb[i])
      return false;
  }
  //equivalent values for every corresponding key, and
  //~~~possibly expensive deep test
  for (i = ka.length - 1; i >= 0; i--) {
    key = ka[i];
    if (!_deepEqual(a[key], b[key])) return false;
  }
  return true;
}

// 8. The non-equivalence assertion tests for any deep inequality.
// assert.notDeepEqual(actual, expected, message_opt);

assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (_deepEqual(actual, expected)) {
    fail(actual, expected, message, 'notDeepEqual', assert.notDeepEqual);
  }
};

// 9. The strict equality assertion tests strict equality, as determined by ===.
// assert.strictEqual(actual, expected, message_opt);

assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(actual, expected, message, '===', assert.strictEqual);
  }
};

// 10. The strict non-equality assertion tests for strict inequality, as
// determined by !==.  assert.notStrictEqual(actual, expected, message_opt);

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    fail(actual, expected, message, '!==', assert.notStrictEqual);
  }
};

function expectedException(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  if (Object.prototype.toString.call(expected) == '[object RegExp]') {
    return expected.test(actual);
  } else if (actual instanceof expected) {
    return true;
  } else if (expected.call({}, actual) === true) {
    return true;
  }

  return false;
}

function _throws(shouldThrow, block, expected, message) {
  var actual;

  if (util.isString(expected)) {
    message = expected;
    expected = null;
  }

  try {
    block();
  } catch (e) {
    actual = e;
  }

  message = (expected && expected.name ? ' (' + expected.name + ').' : '.') +
            (message ? ' ' + message : '.');

  if (shouldThrow && !actual) {
    fail(actual, expected, 'Missing expected exception' + message);
  }

  if (!shouldThrow && expectedException(actual, expected)) {
    fail(actual, expected, 'Got unwanted exception' + message);
  }

  if ((shouldThrow && actual && expected &&
      !expectedException(actual, expected)) || (!shouldThrow && actual)) {
    throw actual;
  }
}

// 11. Expected to throw an error:
// assert.throws(block, Error_opt, message_opt);

assert.throws = function(block, /*optional*/error, /*optional*/message) {
  _throws.apply(this, [true].concat(pSlice.call(arguments)));
};

// EXTENSION! This is annoying to write outside this module.
assert.doesNotThrow = function(block, /*optional*/message) {
  _throws.apply(this, [false].concat(pSlice.call(arguments)));
};

assert.ifError = function(err) { if (err) {throw err;}};

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    if (hasOwn.call(obj, key)) keys.push(key);
  }
  return keys;
};

},{"util/":104}],4:[function(_dereq_,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)
	var PLUS_URL_SAFE = '-'.charCodeAt(0)
	var SLASH_URL_SAFE = '_'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS ||
		    code === PLUS_URL_SAFE)
			return 62 // '+'
		if (code === SLASH ||
		    code === SLASH_URL_SAFE)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],5:[function(_dereq_,module,exports){

},{}],6:[function(_dereq_,module,exports){
arguments[4][5][0].apply(exports,arguments)
},{"dup":5}],7:[function(_dereq_,module,exports){
(function (global){
'use strict';

var buffer = _dereq_('buffer');
var Buffer = buffer.Buffer;
var SlowBuffer = buffer.SlowBuffer;
var MAX_LEN = buffer.kMaxLength || 2147483647;
exports.alloc = function alloc(size, fill, encoding) {
  if (typeof Buffer.alloc === 'function') {
    return Buffer.alloc(size, fill, encoding);
  }
  if (typeof encoding === 'number') {
    throw new TypeError('encoding must not be number');
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size > MAX_LEN) {
    throw new RangeError('size is too large');
  }
  var enc = encoding;
  var _fill = fill;
  if (_fill === undefined) {
    enc = undefined;
    _fill = 0;
  }
  var buf = new Buffer(size);
  if (typeof _fill === 'string') {
    var fillBuf = new Buffer(_fill, enc);
    var flen = fillBuf.length;
    var i = -1;
    while (++i < size) {
      buf[i] = fillBuf[i % flen];
    }
  } else {
    buf.fill(_fill);
  }
  return buf;
}
exports.allocUnsafe = function allocUnsafe(size) {
  if (typeof Buffer.allocUnsafe === 'function') {
    return Buffer.allocUnsafe(size);
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size > MAX_LEN) {
    throw new RangeError('size is too large');
  }
  return new Buffer(size);
}
exports.from = function from(value, encodingOrOffset, length) {
  if (typeof Buffer.from === 'function' && (!global.Uint8Array || Uint8Array.from !== Buffer.from)) {
    return Buffer.from(value, encodingOrOffset, length);
  }
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number');
  }
  if (typeof value === 'string') {
    return new Buffer(value, encodingOrOffset);
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    var offset = encodingOrOffset;
    if (arguments.length === 1) {
      return new Buffer(value);
    }
    if (typeof offset === 'undefined') {
      offset = 0;
    }
    var len = length;
    if (typeof len === 'undefined') {
      len = value.byteLength - offset;
    }
    if (offset >= value.byteLength) {
      throw new RangeError('\'offset\' is out of bounds');
    }
    if (len > value.byteLength - offset) {
      throw new RangeError('\'length\' is out of bounds');
    }
    return new Buffer(value.slice(offset, offset + len));
  }
  if (Buffer.isBuffer(value)) {
    var out = new Buffer(value.length);
    value.copy(out, 0, 0, value.length);
    return out;
  }
  if (value) {
    if (Array.isArray(value) || (typeof ArrayBuffer !== 'undefined' && value.buffer instanceof ArrayBuffer) || 'length' in value) {
      return new Buffer(value);
    }
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return new Buffer(value.data);
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ' + 'ArrayBuffer, Array, or array-like object.');
}
exports.allocUnsafeSlow = function allocUnsafeSlow(size) {
  if (typeof Buffer.allocUnsafeSlow === 'function') {
    return Buffer.allocUnsafeSlow(size);
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size >= MAX_LEN) {
    throw new RangeError('size is too large');
  }
  return new SlowBuffer(size);
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"buffer":8}],8:[function(_dereq_,module,exports){
(function (global){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = _dereq_('base64-js')
var ieee754 = _dereq_('ieee754')
var isArray = _dereq_('isarray')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var rootParent = {}

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Due to various browser bugs, sometimes the Object implementation will be used even
 * when the browser supports typed arrays.
 *
 * Note:
 *
 *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
 *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *   - Safari 5-7 lacks support for changing the `Object.prototype.constructor` property
 *     on objects.
 *
 *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *     incorrect length in some situations.

 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
 * get the Object implementation, which is slower but behaves correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
  ? global.TYPED_ARRAY_SUPPORT
  : typedArraySupport()

function typedArraySupport () {
  function Bar () {}
  try {
    var arr = new Uint8Array(1)
    arr.foo = function () { return 42 }
    arr.constructor = Bar
    return arr.foo() === 42 && // typed array instances can be augmented
        arr.constructor === Bar && // constructor can be set
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
}

function kMaxLength () {
  return Buffer.TYPED_ARRAY_SUPPORT
    ? 0x7fffffff
    : 0x3fffffff
}

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (arg) {
  if (!(this instanceof Buffer)) {
    // Avoid going through an ArgumentsAdaptorTrampoline in the common case.
    if (arguments.length > 1) return new Buffer(arg, arguments[1])
    return new Buffer(arg)
  }

  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    this.length = 0
    this.parent = undefined
  }

  // Common case.
  if (typeof arg === 'number') {
    return fromNumber(this, arg)
  }

  // Slightly less common case.
  if (typeof arg === 'string') {
    return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8')
  }

  // Unusual.
  return fromObject(this, arg)
}

function fromNumber (that, length) {
  that = allocate(that, length < 0 ? 0 : checked(length) | 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < length; i++) {
      that[i] = 0
    }
  }
  return that
}

function fromString (that, string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') encoding = 'utf8'

  // Assumption: byteLength() return value is always < kMaxLength.
  var length = byteLength(string, encoding) | 0
  that = allocate(that, length)

  that.write(string, encoding)
  return that
}

function fromObject (that, object) {
  if (Buffer.isBuffer(object)) return fromBuffer(that, object)

  if (isArray(object)) return fromArray(that, object)

  if (object == null) {
    throw new TypeError('must start with number, buffer, array or string')
  }

  if (typeof ArrayBuffer !== 'undefined') {
    if (object.buffer instanceof ArrayBuffer) {
      return fromTypedArray(that, object)
    }
    if (object instanceof ArrayBuffer) {
      return fromArrayBuffer(that, object)
    }
  }

  if (object.length) return fromArrayLike(that, object)

  return fromJsonObject(that, object)
}

function fromBuffer (that, buffer) {
  var length = checked(buffer.length) | 0
  that = allocate(that, length)
  buffer.copy(that, 0, 0, length)
  return that
}

function fromArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Duplicate of fromArray() to keep fromArray() monomorphic.
function fromTypedArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  // Truncating the elements is probably not what people expect from typed
  // arrays with BYTES_PER_ELEMENT > 1 but it's compatible with the behavior
  // of the old Buffer constructor.
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

function fromArrayBuffer (that, array) {
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    array.byteLength
    that = Buffer._augment(new Uint8Array(array))
  } else {
    // Fallback: Return an object instance of the Buffer class
    that = fromTypedArray(that, new Uint8Array(array))
  }
  return that
}

function fromArrayLike (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Deserialize { type: 'Buffer', data: [1,2,3,...] } into a Buffer object.
// Returns a zero-length buffer for inputs that don't conform to the spec.
function fromJsonObject (that, object) {
  var array
  var length = 0

  if (object.type === 'Buffer' && isArray(object.data)) {
    array = object.data
    length = checked(array.length) | 0
  }
  that = allocate(that, length)

  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

if (Buffer.TYPED_ARRAY_SUPPORT) {
  Buffer.prototype.__proto__ = Uint8Array.prototype
  Buffer.__proto__ = Uint8Array
} else {
  // pre-set for values that may exist in the future
  Buffer.prototype.length = undefined
  Buffer.prototype.parent = undefined
}

function allocate (that, length) {
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = Buffer._augment(new Uint8Array(length))
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that.length = length
    that._isBuffer = true
  }

  var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1
  if (fromPool) that.parent = rootParent

  return that
}

function checked (length) {
  // Note: cannot use `length < kMaxLength` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= kMaxLength()) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + kMaxLength().toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (subject, encoding) {
  if (!(this instanceof SlowBuffer)) return new SlowBuffer(subject, encoding)

  var buf = new Buffer(subject, encoding)
  delete buf.parent
  return buf
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  var i = 0
  var len = Math.min(x, y)
  while (i < len) {
    if (a[i] !== b[i]) break

    ++i
  }

  if (i !== len) {
    x = a[i]
    y = b[i]
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!isArray(list)) throw new TypeError('list argument must be an Array of Buffers.')

  if (list.length === 0) {
    return new Buffer(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; i++) {
      length += list[i].length
    }
  }

  var buf = new Buffer(length)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

function byteLength (string, encoding) {
  if (typeof string !== 'string') string = '' + string

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'binary':
      // Deprecated
      case 'raw':
      case 'raws':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  start = start | 0
  end = end === undefined || end === Infinity ? this.length : end | 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toString = function toString () {
  var length = this.length | 0
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return 0
  return Buffer.compare(this, b)
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset) {
  if (byteOffset > 0x7fffffff) byteOffset = 0x7fffffff
  else if (byteOffset < -0x80000000) byteOffset = -0x80000000
  byteOffset >>= 0

  if (this.length === 0) return -1
  if (byteOffset >= this.length) return -1

  // Negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

  if (typeof val === 'string') {
    if (val.length === 0) return -1 // special case: looking for empty string always fails
    return String.prototype.indexOf.call(this, val, byteOffset)
  }
  if (Buffer.isBuffer(val)) {
    return arrayIndexOf(this, val, byteOffset)
  }
  if (typeof val === 'number') {
    if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
      return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
    }
    return arrayIndexOf(this, [ val ], byteOffset)
  }

  function arrayIndexOf (arr, val, byteOffset) {
    var foundIndex = -1
    for (var i = 0; byteOffset + i < arr.length; i++) {
      if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === val.length) return byteOffset + foundIndex
      } else {
        foundIndex = -1
      }
    }
    return -1
  }

  throw new TypeError('val must be string, number or Buffer')
}

// `get` is deprecated
Buffer.prototype.get = function get (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` is deprecated
Buffer.prototype.set = function set (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) throw new Error('Invalid hex string')
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset | 0
    if (isFinite(length)) {
      length = length | 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  // legacy write(string, encoding, offset, length) - remove in v0.13
  } else {
    var swap = encoding
    encoding = offset
    offset = length | 0
    length = swap
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'binary':
        return binaryWrite(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function binarySlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
  }

  if (newBuf.length) newBuf.parent = this.parent || this

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = (value & 0xff)
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
  if (offset < 0) throw new RangeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; i--) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    // ascending copy from start
    for (i = 0; i < len; i++) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), targetStart)
  }

  return len
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function fill (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new RangeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new RangeError('start out of bounds')
  if (end < 0 || end > this.length) throw new RangeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function toArrayBuffer () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function _augment (arr) {
  arr.constructor = Buffer
  arr._isBuffer = true

  // save reference to original Uint8Array set method before overwriting
  arr._set = arr.set

  // deprecated
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.indexOf = BP.indexOf
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUIntLE = BP.readUIntLE
  arr.readUIntBE = BP.readUIntBE
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readIntLE = BP.readIntLE
  arr.readIntBE = BP.readIntBE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUIntLE = BP.writeUIntLE
  arr.writeUIntBE = BP.writeUIntBE
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeIntLE = BP.writeIntLE
  arr.writeIntBE = BP.writeIntBE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; i++) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"base64-js":4,"ieee754":12,"isarray":9}],9:[function(_dereq_,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],10:[function(_dereq_,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":_dereq_("../../is-buffer/index.js")})
},{"../../is-buffer/index.js":15}],11:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],12:[function(_dereq_,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],13:[function(_dereq_,module,exports){
(function (global){
'use strict';
var Mutation = global.MutationObserver || global.WebKitMutationObserver;

var scheduleDrain;

{
  if (Mutation) {
    var called = 0;
    var observer = new Mutation(nextTick);
    var element = global.document.createTextNode('');
    observer.observe(element, {
      characterData: true
    });
    scheduleDrain = function () {
      element.data = (called = ++called % 2);
    };
  } else if (!global.setImmediate && typeof global.MessageChannel !== 'undefined') {
    var channel = new global.MessageChannel();
    channel.port1.onmessage = nextTick;
    scheduleDrain = function () {
      channel.port2.postMessage(0);
    };
  } else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {
    scheduleDrain = function () {

      // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
      // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
      var scriptEl = global.document.createElement('script');
      scriptEl.onreadystatechange = function () {
        nextTick();

        scriptEl.onreadystatechange = null;
        scriptEl.parentNode.removeChild(scriptEl);
        scriptEl = null;
      };
      global.document.documentElement.appendChild(scriptEl);
    };
  } else {
    scheduleDrain = function () {
      setTimeout(nextTick, 0);
    };
  }
}

var draining;
var queue = [];
//named nextTick for less confusing stack traces
function nextTick() {
  draining = true;
  var i, oldQueue;
  var len = queue.length;
  while (len) {
    oldQueue = queue;
    queue = [];
    i = -1;
    while (++i < len) {
      oldQueue[i]();
    }
    len = queue.length;
  }
  draining = false;
}

module.exports = immediate;
function immediate(task) {
  if (queue.push(task) === 1 && !draining) {
    scheduleDrain();
  }
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],14:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],15:[function(_dereq_,module,exports){
/*!
 * Determine if an object is a Buffer
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

// The _isBuffer check is for Safari 5-7 support, because it's missing
// Object.prototype.constructor. Remove this eventually
module.exports = function (obj) {
  return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer)
}

function isBuffer (obj) {
  return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj)
}

// For Node v0.10 support. Remove this eventually.
function isSlowBuffer (obj) {
  return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0))
}

},{}],16:[function(_dereq_,module,exports){
'use strict';
var immediate = _dereq_('immediate');

/* istanbul ignore next */
function INTERNAL() {}

var handlers = {};

var REJECTED = ['REJECTED'];
var FULFILLED = ['FULFILLED'];
var PENDING = ['PENDING'];

module.exports = Promise;

function Promise(resolver) {
  if (typeof resolver !== 'function') {
    throw new TypeError('resolver must be a function');
  }
  this.state = PENDING;
  this.queue = [];
  this.outcome = void 0;
  if (resolver !== INTERNAL) {
    safelyResolveThenable(this, resolver);
  }
}

Promise.prototype["catch"] = function (onRejected) {
  return this.then(null, onRejected);
};
Promise.prototype.then = function (onFulfilled, onRejected) {
  if (typeof onFulfilled !== 'function' && this.state === FULFILLED ||
    typeof onRejected !== 'function' && this.state === REJECTED) {
    return this;
  }
  var promise = new this.constructor(INTERNAL);
  if (this.state !== PENDING) {
    var resolver = this.state === FULFILLED ? onFulfilled : onRejected;
    unwrap(promise, resolver, this.outcome);
  } else {
    this.queue.push(new QueueItem(promise, onFulfilled, onRejected));
  }

  return promise;
};
function QueueItem(promise, onFulfilled, onRejected) {
  this.promise = promise;
  if (typeof onFulfilled === 'function') {
    this.onFulfilled = onFulfilled;
    this.callFulfilled = this.otherCallFulfilled;
  }
  if (typeof onRejected === 'function') {
    this.onRejected = onRejected;
    this.callRejected = this.otherCallRejected;
  }
}
QueueItem.prototype.callFulfilled = function (value) {
  handlers.resolve(this.promise, value);
};
QueueItem.prototype.otherCallFulfilled = function (value) {
  unwrap(this.promise, this.onFulfilled, value);
};
QueueItem.prototype.callRejected = function (value) {
  handlers.reject(this.promise, value);
};
QueueItem.prototype.otherCallRejected = function (value) {
  unwrap(this.promise, this.onRejected, value);
};

function unwrap(promise, func, value) {
  immediate(function () {
    var returnValue;
    try {
      returnValue = func(value);
    } catch (e) {
      return handlers.reject(promise, e);
    }
    if (returnValue === promise) {
      handlers.reject(promise, new TypeError('Cannot resolve promise with itself'));
    } else {
      handlers.resolve(promise, returnValue);
    }
  });
}

handlers.resolve = function (self, value) {
  var result = tryCatch(getThen, value);
  if (result.status === 'error') {
    return handlers.reject(self, result.value);
  }
  var thenable = result.value;

  if (thenable) {
    safelyResolveThenable(self, thenable);
  } else {
    self.state = FULFILLED;
    self.outcome = value;
    var i = -1;
    var len = self.queue.length;
    while (++i < len) {
      self.queue[i].callFulfilled(value);
    }
  }
  return self;
};
handlers.reject = function (self, error) {
  self.state = REJECTED;
  self.outcome = error;
  var i = -1;
  var len = self.queue.length;
  while (++i < len) {
    self.queue[i].callRejected(error);
  }
  return self;
};

function getThen(obj) {
  // Make sure we only access the accessor once as required by the spec
  var then = obj && obj.then;
  if (obj && typeof obj === 'object' && typeof then === 'function') {
    return function appyThen() {
      then.apply(obj, arguments);
    };
  }
}

function safelyResolveThenable(self, thenable) {
  // Either fulfill, reject or reject with error
  var called = false;
  function onError(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.reject(self, value);
  }

  function onSuccess(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.resolve(self, value);
  }

  function tryToUnwrap() {
    thenable(onSuccess, onError);
  }

  var result = tryCatch(tryToUnwrap);
  if (result.status === 'error') {
    onError(result.value);
  }
}

function tryCatch(func, value) {
  var out = {};
  try {
    out.value = func(value);
    out.status = 'success';
  } catch (e) {
    out.status = 'error';
    out.value = e;
  }
  return out;
}

Promise.resolve = resolve;
function resolve(value) {
  if (value instanceof this) {
    return value;
  }
  return handlers.resolve(new this(INTERNAL), value);
}

Promise.reject = reject;
function reject(reason) {
  var promise = new this(INTERNAL);
  return handlers.reject(promise, reason);
}

Promise.all = all;
function all(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var values = new Array(len);
  var resolved = 0;
  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    allResolver(iterable[i], i);
  }
  return promise;
  function allResolver(value, i) {
    self.resolve(value).then(resolveFromAll, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
    function resolveFromAll(outValue) {
      values[i] = outValue;
      if (++resolved === len && !called) {
        called = true;
        handlers.resolve(promise, values);
      }
    }
  }
}

Promise.race = race;
function race(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    resolver(iterable[i]);
  }
  return promise;
  function resolver(value) {
    self.resolve(value).then(function (response) {
      if (!called) {
        called = true;
        handlers.resolve(promise, response);
      }
    }, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
  }
}

},{"immediate":13}],17:[function(_dereq_,module,exports){
exports.endianness = function () { return 'LE' };

exports.hostname = function () {
    if (typeof location !== 'undefined') {
        return location.hostname
    }
    else return '';
};

exports.loadavg = function () { return [] };

exports.uptime = function () { return 0 };

exports.freemem = function () {
    return Number.MAX_VALUE;
};

exports.totalmem = function () {
    return Number.MAX_VALUE;
};

exports.cpus = function () { return [] };

exports.type = function () { return 'Browser' };

exports.release = function () {
    if (typeof navigator !== 'undefined') {
        return navigator.appVersion;
    }
    return '';
};

exports.networkInterfaces
= exports.getNetworkInterfaces
= function () { return {} };

exports.arch = function () { return 'javascript' };

exports.platform = function () { return 'browser' };

exports.tmpdir = exports.tmpDir = function () {
    return '/tmp';
};

exports.EOL = '\n';

},{}],18:[function(_dereq_,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,_dereq_('_process'))
},{"_process":20}],19:[function(_dereq_,module,exports){
(function (process){
'use strict';

if (!process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = nextTick;
} else {
  module.exports = process.nextTick;
}

function nextTick(fn, arg1, arg2, arg3) {
  if (typeof fn !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }
  var len = arguments.length;
  var args, i;
  switch (len) {
  case 0:
  case 1:
    return process.nextTick(fn);
  case 2:
    return process.nextTick(function afterTickOne() {
      fn.call(null, arg1);
    });
  case 3:
    return process.nextTick(function afterTickTwo() {
      fn.call(null, arg1, arg2);
    });
  case 4:
    return process.nextTick(function afterTickThree() {
      fn.call(null, arg1, arg2, arg3);
    });
  default:
    args = new Array(len - 1);
    i = 0;
    while (i < args.length) {
      args[i++] = arguments[i];
    }
    return process.nextTick(function afterTick() {
      fn.apply(null, args);
    });
  }
}

}).call(this,_dereq_('_process'))
},{"_process":20}],20:[function(_dereq_,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],21:[function(_dereq_,module,exports){
(function (global){
/*! https://mths.be/punycode v1.4.1 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.4.1',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) {
			// in Node.js, io.js, or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else {
			// in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else {
		// in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],22:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],23:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],24:[function(_dereq_,module,exports){
'use strict';

exports.decode = exports.parse = _dereq_('./decode');
exports.encode = exports.stringify = _dereq_('./encode');

},{"./decode":22,"./encode":23}],25:[function(_dereq_,module,exports){
(function (process,__dirname){
var binary = _dereq_('node-pre-gyp');
var path = _dereq_('path');
var binding_path = binary.find(path.resolve(path.join(__dirname,'../package.json')));
var binding = _dereq_(binding_path);
var sqlite3 = module.exports = exports = binding;
var EventEmitter = _dereq_('events').EventEmitter;

function normalizeMethod (fn) {
    return function (sql) {
        var errBack;
        var args = Array.prototype.slice.call(arguments, 1);
        if (typeof args[args.length - 1] === 'function') {
            var callback = args[args.length - 1];
            errBack = function(err) {
                if (err) {
                    callback(err);
                }
            };
        }
        var statement = new Statement(this, sql, errBack);
        return fn.call(this, statement, args);
    };
}

function inherits(target, source) {
    for (var k in source.prototype)
        target.prototype[k] = source.prototype[k];
}

sqlite3.cached = {
    Database: function(file, a, b) {
        if (file === '' || file === ':memory:') {
            // Don't cache special databases.
            return new Database(file, a, b);
        }

        var db;
        file = path.resolve(file);
        function cb() { callback.call(db, null); }

        if (!sqlite3.cached.objects[file]) {
            db = sqlite3.cached.objects[file] = new Database(file, a, b);
        }
        else {
            // Make sure the callback is called.
            db = sqlite3.cached.objects[file];
            var callback = (typeof a === 'number') ? b : a;
            if (typeof callback === 'function') {
                if (db.open) process.nextTick(cb);
                else db.once('open', cb);
            }
        }

        return db;
    },
    objects: {}
};


var Database = sqlite3.Database;
var Statement = sqlite3.Statement;

inherits(Database, EventEmitter);
inherits(Statement, EventEmitter);

// Database#prepare(sql, [bind1, bind2, ...], [callback])
Database.prototype.prepare = normalizeMethod(function(statement, params) {
    return params.length
        ? statement.bind.apply(statement, params)
        : statement;
});

// Database#run(sql, [bind1, bind2, ...], [callback])
Database.prototype.run = normalizeMethod(function(statement, params) {
    statement.run.apply(statement, params).finalize();
    return this;
});

// Database#get(sql, [bind1, bind2, ...], [callback])
Database.prototype.get = normalizeMethod(function(statement, params) {
    statement.get.apply(statement, params).finalize();
    return this;
});

// Database#all(sql, [bind1, bind2, ...], [callback])
Database.prototype.all = normalizeMethod(function(statement, params) {
    statement.all.apply(statement, params).finalize();
    return this;
});

// Database#each(sql, [bind1, bind2, ...], [callback], [complete])
Database.prototype.each = normalizeMethod(function(statement, params) {
    statement.each.apply(statement, params).finalize();
    return this;
});

Database.prototype.map = normalizeMethod(function(statement, params) {
    statement.map.apply(statement, params).finalize();
    return this;
});

Statement.prototype.map = function() {
    var params = Array.prototype.slice.call(arguments);
    var callback = params.pop();
    params.push(function(err, rows) {
        if (err) return callback(err);
        var result = {};
        if (rows.length) {
            var keys = Object.keys(rows[0]), key = keys[0];
            if (keys.length > 2) {
                // Value is an object
                for (var i = 0; i < rows.length; i++) {
                    result[rows[i][key]] = rows[i];
                }
            } else {
                var value = keys[1];
                // Value is a plain value
                for (i = 0; i < rows.length; i++) {
                    result[rows[i][key]] = rows[i][value];
                }
            }
        }
        callback(err, result);
    });
    return this.all.apply(this, params);
};

var isVerbose = false;

var supportedEvents = [ 'trace', 'profile', 'insert', 'update', 'delete' ];

Database.prototype.addListener = Database.prototype.on = function(type) {
    var val = EventEmitter.prototype.addListener.apply(this, arguments);
    if (supportedEvents.indexOf(type) >= 0) {
        this.configure(type, true);
    }
    return val;
};

Database.prototype.removeListener = function(type) {
    var val = EventEmitter.prototype.removeListener.apply(this, arguments);
    if (supportedEvents.indexOf(type) >= 0 && !this._events[type]) {
        this.configure(type, false);
    }
    return val;
};

Database.prototype.removeAllListeners = function(type) {
    var val = EventEmitter.prototype.removeAllListeners.apply(this, arguments);
    if (supportedEvents.indexOf(type) >= 0) {
        this.configure(type, false);
    }
    return val;
};

// Save the stack trace over EIO callbacks.
sqlite3.verbose = function() {
    if (!isVerbose) {
        var trace = _dereq_('./trace');
        [
            'prepare',
            'get',
            'run',
            'all',
            'each',
            'map',
            'close',
            'exec'
        ].forEach(function (name) {
            trace.extendTrace(Database.prototype, name);
        });
        [
            'bind',
            'get',
            'run',
            'all',
            'each',
            'map',
            'reset',
            'finalize',
        ].forEach(function (name) {
            trace.extendTrace(Statement.prototype, name);
        });
        isVerbose = true;
    }

    return this;
};

}).call(this,_dereq_('_process'),"/node_modules\\sqlite3\\lib")
},{"./trace":26,"_process":20,"events":11,"node-pre-gyp":27,"path":18}],26:[function(_dereq_,module,exports){
(function (__filename){
// Inspired by https://github.com/tlrobinson/long-stack-traces
var util = _dereq_('util');

function extendTrace(object, property, pos) {
    var old = object[property];
    object[property] = function() {
        var error = new Error();
        var name = object.constructor.name + '#' + property + '(' + 
            Array.prototype.slice.call(arguments).map(function(el) {
                return util.inspect(el, false, 0);
            }).join(', ') + ')';

        if (typeof pos === 'undefined') pos = -1;
        if (pos < 0) pos += arguments.length;
        var cb = arguments[pos];
        if (typeof arguments[pos] === 'function') {
            arguments[pos] = function replacement() {
                try {
                    return cb.apply(this, arguments);
                } catch (err) {
                    if (err && err.stack && !err.__augmented) {
                        err.stack = filter(err).join('\n');
                        err.stack += '\n--> in ' + name;
                        err.stack += '\n' + filter(error).slice(1).join('\n');
                        err.__augmented = true;
                    }
                    throw err;
                }
            };
        }
        return old.apply(this, arguments);
    };
}
exports.extendTrace = extendTrace;


function filter(error) {
    return error.stack.split('\n').filter(function(line) {
        return line.indexOf(__filename) < 0;
    });
}

}).call(this,"/node_modules\\sqlite3\\lib\\trace.js")
},{"util":104}],27:[function(_dereq_,module,exports){
(function (process,__dirname){
"use strict";

/**
 * Module exports.
 */

module.exports = exports;

/**
 * Module dependencies.
 */

var path = _dereq_('path');
var nopt = _dereq_('nopt');
var log = _dereq_('npmlog');
var EE = _dereq_('events').EventEmitter;
var inherits = _dereq_('util').inherits;
var commands = [
      'clean',
      'install',
      'reinstall',
      'build',
      'rebuild',
      'package',
      'testpackage',
      'publish',
      'unpublish',
      'info',
      'testbinary',
      'reveal',
      'configure'
    ];
var aliases = {};

// differentiate node-pre-gyp's logs from npm's
log.heading = 'node-pre-gyp';

exports.find = _dereq_('./pre-binding').find;

function Run() {
  var self = this;

  this.commands = {};

  commands.forEach(function (command) {
    self.commands[command] = function (argv, callback) {
      log.verbose('command', command, argv);
      return _dereq_('./' + command)(self, argv, callback);
    };
  });
}
inherits(Run, EE);
exports.Run = Run;
var proto = Run.prototype;

/**
 * Export the contents of the package.json.
 */

proto.package = _dereq_('../package');

/**
 * nopt configuration definitions
 */

proto.configDefs = {
    help: Boolean,     // everywhere
    arch: String,      // 'configure'
    debug: Boolean,    // 'build'
    directory: String, // bin
    proxy: String,     // 'install'
    loglevel: String,  // everywhere
};

/**
 * nopt shorthands
 */

proto.shorthands = {
    release: '--no-debug',
    C: '--directory',
    debug: '--debug',
    j: '--jobs',
    silent: '--loglevel=silent',
    silly: '--loglevel=silly',
    verbose: '--loglevel=verbose',
};

/**
 * expose the command aliases for the bin file to use.
 */

proto.aliases = aliases;

/**
 * Parses the given argv array and sets the 'opts',
 * 'argv' and 'command' properties.
 */

proto.parseArgv = function parseOpts (argv) {
  this.opts = nopt(this.configDefs, this.shorthands, argv);
  this.argv = this.opts.argv.remain.slice();
  var commands = this.todo = [];

  // create a copy of the argv array with aliases mapped
  argv = this.argv.map(function (arg) {
    // is this an alias?
    if (arg in this.aliases) {
      arg = this.aliases[arg];
    }
    return arg;
  }, this);

  // process the mapped args into "command" objects ("name" and "args" props)
  argv.slice().forEach(function (arg) {
    if (arg in this.commands) {
      var args = argv.splice(0, argv.indexOf(arg));
      argv.shift();
      if (commands.length > 0) {
        commands[commands.length - 1].args = args;
      }
      commands.push({ name: arg, args: [] });
    }
  }, this);
  if (commands.length > 0) {
    commands[commands.length - 1].args = argv.splice(0);
  }

  // support for inheriting config env variables from npm
  var npm_config_prefix = 'npm_config_';
  Object.keys(process.env).forEach(function (name) {
    if (name.indexOf(npm_config_prefix) !== 0) return;
    var val = process.env[name];
    if (name === npm_config_prefix + 'loglevel') {
      log.level = val;
    } else {
      // add the user-defined options to the config
      name = name.substring(npm_config_prefix.length);
      // avoid npm argv clobber already present args
      // which avoids problem of 'npm test' calling
      // script that runs unique npm install commands
      if (name === 'argv') {
         if (this.opts.argv &&
             this.opts.argv.remain &&
             this.opts.argv.remain.length) {
            // do nothing
         } else {
            this.opts[name] = val;
         }
      } else {
        this.opts[name] = val;
      }
    }
  }, this);

  if (this.opts.loglevel) {
    log.level = this.opts.loglevel;
  }
  log.resume();
};

/**
 * Returns the usage instructions for node-pre-gyp.
 */

proto.usage = function usage () {
  var str = [
      '',
      '  Usage: node-pre-gyp <command> [options]',
      '',
      '  where <command> is one of:',
      commands.map(function (c) {
        return '    - ' + c + ' - ' + _dereq_('./' + c).usage;
      }).join('\n'),
      '',
      'node-pre-gyp@' + this.version + '  ' + path.resolve(__dirname, '..'),
      'node@' + process.versions.node
  ].join('\n');
  return str;
};

/**
 * Version number getter.
 */

Object.defineProperty(proto, 'version', {
    get: function () {
      return this.package.version;
    },
    enumerable: true
});


}).call(this,_dereq_('_process'),"/node_modules\\sqlite3\\node_modules\\node-pre-gyp\\lib")
},{"../package":85,"./pre-binding":28,"_process":20,"events":11,"nopt":31,"npmlog":33,"path":18,"util":104}],28:[function(_dereq_,module,exports){
"use strict";

var versioning = _dereq_('../lib/util/versioning.js');
var existsSync = _dereq_('fs').existsSync || _dereq_('path').existsSync;
var path = _dereq_('path');

module.exports = exports;

exports.usage = 'Finds the require path for the node-pre-gyp installed module';

exports.validate = function(package_json) {
    versioning.validate_config(package_json);
};

exports.find = function(package_json_path,opts) {
   if (!existsSync(package_json_path)) {
        throw new Error("package.json does not exist at " + package_json_path);
   }
   var package_json = _dereq_(package_json_path);
   versioning.validate_config(package_json);
   opts = opts || {};
   if (!opts.module_root) opts.module_root = path.dirname(package_json_path);
   var meta = versioning.evaluate(package_json,opts);
   return meta.module;
};

},{"../lib/util/versioning.js":30,"fs":6,"path":18}],29:[function(_dereq_,module,exports){
module.exports={
  "0.1.14": {
    "node_abi": null,
    "v8": "1.3"
  },
  "0.1.15": {
    "node_abi": null,
    "v8": "1.3"
  },
  "0.1.16": {
    "node_abi": null,
    "v8": "1.3"
  },
  "0.1.17": {
    "node_abi": null,
    "v8": "1.3"
  },
  "0.1.18": {
    "node_abi": null,
    "v8": "1.3"
  },
  "0.1.19": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.20": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.21": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.22": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.23": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.24": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.25": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.26": {
    "node_abi": null,
    "v8": "2.0"
  },
  "0.1.27": {
    "node_abi": null,
    "v8": "2.1"
  },
  "0.1.28": {
    "node_abi": null,
    "v8": "2.1"
  },
  "0.1.29": {
    "node_abi": null,
    "v8": "2.1"
  },
  "0.1.30": {
    "node_abi": null,
    "v8": "2.1"
  },
  "0.1.31": {
    "node_abi": null,
    "v8": "2.1"
  },
  "0.1.32": {
    "node_abi": null,
    "v8": "2.1"
  },
  "0.1.33": {
    "node_abi": null,
    "v8": "2.1"
  },
  "0.1.90": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.91": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.92": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.93": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.94": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.95": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.96": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.97": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.98": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.99": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.100": {
    "node_abi": null,
    "v8": "2.2"
  },
  "0.1.101": {
    "node_abi": null,
    "v8": "2.3"
  },
  "0.1.102": {
    "node_abi": null,
    "v8": "2.3"
  },
  "0.1.103": {
    "node_abi": null,
    "v8": "2.3"
  },
  "0.1.104": {
    "node_abi": null,
    "v8": "2.3"
  },
  "0.2.0": {
    "node_abi": 1,
    "v8": "2.3"
  },
  "0.2.1": {
    "node_abi": 1,
    "v8": "2.3"
  },
  "0.2.2": {
    "node_abi": 1,
    "v8": "2.3"
  },
  "0.2.3": {
    "node_abi": 1,
    "v8": "2.3"
  },
  "0.2.4": {
    "node_abi": 1,
    "v8": "2.3"
  },
  "0.2.5": {
    "node_abi": 1,
    "v8": "2.3"
  },
  "0.2.6": {
    "node_abi": 1,
    "v8": "2.3"
  },
  "0.3.0": {
    "node_abi": 1,
    "v8": "2.5"
  },
  "0.3.1": {
    "node_abi": 1,
    "v8": "2.5"
  },
  "0.3.2": {
    "node_abi": 1,
    "v8": "3.0"
  },
  "0.3.3": {
    "node_abi": 1,
    "v8": "3.0"
  },
  "0.3.4": {
    "node_abi": 1,
    "v8": "3.0"
  },
  "0.3.5": {
    "node_abi": 1,
    "v8": "3.0"
  },
  "0.3.6": {
    "node_abi": 1,
    "v8": "3.0"
  },
  "0.3.7": {
    "node_abi": 1,
    "v8": "3.0"
  },
  "0.3.8": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.0": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.1": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.2": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.3": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.4": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.5": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.6": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.7": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.8": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.9": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.10": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.11": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.4.12": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.5.0": {
    "node_abi": 1,
    "v8": "3.1"
  },
  "0.5.1": {
    "node_abi": 1,
    "v8": "3.4"
  },
  "0.5.2": {
    "node_abi": 1,
    "v8": "3.4"
  },
  "0.5.3": {
    "node_abi": 1,
    "v8": "3.4"
  },
  "0.5.4": {
    "node_abi": 1,
    "v8": "3.5"
  },
  "0.5.5": {
    "node_abi": 1,
    "v8": "3.5"
  },
  "0.5.6": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.5.7": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.5.8": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.5.9": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.5.10": {
    "node_abi": 1,
    "v8": "3.7"
  },
  "0.6.0": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.1": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.2": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.3": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.4": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.5": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.6": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.7": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.8": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.9": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.10": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.11": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.12": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.13": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.14": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.15": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.16": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.17": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.18": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.19": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.20": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.6.21": {
    "node_abi": 1,
    "v8": "3.6"
  },
  "0.7.0": {
    "node_abi": 1,
    "v8": "3.8"
  },
  "0.7.1": {
    "node_abi": 1,
    "v8": "3.8"
  },
  "0.7.2": {
    "node_abi": 1,
    "v8": "3.8"
  },
  "0.7.3": {
    "node_abi": 1,
    "v8": "3.9"
  },
  "0.7.4": {
    "node_abi": 1,
    "v8": "3.9"
  },
  "0.7.5": {
    "node_abi": 1,
    "v8": "3.9"
  },
  "0.7.6": {
    "node_abi": 1,
    "v8": "3.9"
  },
  "0.7.7": {
    "node_abi": 1,
    "v8": "3.9"
  },
  "0.7.8": {
    "node_abi": 1,
    "v8": "3.9"
  },
  "0.7.9": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.7.10": {
    "node_abi": 1,
    "v8": "3.9"
  },
  "0.7.11": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.7.12": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.0": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.1": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.2": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.3": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.4": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.5": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.6": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.7": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.8": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.9": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.10": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.11": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.12": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.13": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.14": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.15": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.16": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.17": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.18": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.19": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.20": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.21": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.22": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.23": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.24": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.25": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.26": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.27": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.8.28": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.9.0": {
    "node_abi": 1,
    "v8": "3.11"
  },
  "0.9.1": {
    "node_abi": 10,
    "v8": "3.11"
  },
  "0.9.2": {
    "node_abi": 10,
    "v8": "3.11"
  },
  "0.9.3": {
    "node_abi": 10,
    "v8": "3.13"
  },
  "0.9.4": {
    "node_abi": 10,
    "v8": "3.13"
  },
  "0.9.5": {
    "node_abi": 10,
    "v8": "3.13"
  },
  "0.9.6": {
    "node_abi": 10,
    "v8": "3.15"
  },
  "0.9.7": {
    "node_abi": 10,
    "v8": "3.15"
  },
  "0.9.8": {
    "node_abi": 10,
    "v8": "3.15"
  },
  "0.9.9": {
    "node_abi": 11,
    "v8": "3.15"
  },
  "0.9.10": {
    "node_abi": 11,
    "v8": "3.15"
  },
  "0.9.11": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.9.12": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.0": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.1": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.2": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.3": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.4": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.5": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.6": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.7": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.8": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.9": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.10": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.11": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.12": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.13": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.14": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.15": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.16": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.17": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.18": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.19": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.20": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.21": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.22": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.23": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.24": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.25": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.26": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.27": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.28": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.29": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.30": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.31": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.32": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.33": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.34": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.35": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.36": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.37": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.38": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.39": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.40": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.41": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.42": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.43": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.44": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.45": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.46": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.47": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.10.48": {
    "node_abi": 11,
    "v8": "3.14"
  },
  "0.11.0": {
    "node_abi": 12,
    "v8": "3.17"
  },
  "0.11.1": {
    "node_abi": 12,
    "v8": "3.18"
  },
  "0.11.2": {
    "node_abi": 12,
    "v8": "3.19"
  },
  "0.11.3": {
    "node_abi": 12,
    "v8": "3.19"
  },
  "0.11.4": {
    "node_abi": 12,
    "v8": "3.20"
  },
  "0.11.5": {
    "node_abi": 12,
    "v8": "3.20"
  },
  "0.11.6": {
    "node_abi": 12,
    "v8": "3.20"
  },
  "0.11.7": {
    "node_abi": 12,
    "v8": "3.20"
  },
  "0.11.8": {
    "node_abi": 13,
    "v8": "3.21"
  },
  "0.11.9": {
    "node_abi": 13,
    "v8": "3.22"
  },
  "0.11.10": {
    "node_abi": 13,
    "v8": "3.22"
  },
  "0.11.11": {
    "node_abi": 14,
    "v8": "3.22"
  },
  "0.11.12": {
    "node_abi": 14,
    "v8": "3.22"
  },
  "0.11.13": {
    "node_abi": 14,
    "v8": "3.25"
  },
  "0.11.14": {
    "node_abi": 14,
    "v8": "3.26"
  },
  "0.11.15": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.11.16": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.0": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.1": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.2": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.3": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.4": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.5": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.6": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.7": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.8": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.9": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.10": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.11": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.12": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.13": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.14": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.15": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.16": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "0.12.17": {
    "node_abi": 14,
    "v8": "3.28"
  },
  "1.0.0": {
    "node_abi": 42,
    "v8": "3.31"
  },
  "1.0.1": {
    "node_abi": 42,
    "v8": "3.31"
  },
  "1.0.2": {
    "node_abi": 42,
    "v8": "3.31"
  },
  "1.0.3": {
    "node_abi": 42,
    "v8": "4.1"
  },
  "1.0.4": {
    "node_abi": 42,
    "v8": "4.1"
  },
  "1.1.0": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.2.0": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.3.0": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.4.1": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.4.2": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.4.3": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.5.0": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.5.1": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.6.0": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.6.1": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.6.2": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.6.3": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.6.4": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.7.1": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.8.1": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.8.2": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.8.3": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "1.8.4": {
    "node_abi": 43,
    "v8": "4.1"
  },
  "2.0.0": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.0.1": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.0.2": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.1.0": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.2.0": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.2.1": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.3.0": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.3.1": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.3.2": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.3.3": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.3.4": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.4.0": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "2.5.0": {
    "node_abi": 44,
    "v8": "4.2"
  },
  "3.0.0": {
    "node_abi": 45,
    "v8": "4.4"
  },
  "3.1.0": {
    "node_abi": 45,
    "v8": "4.4"
  },
  "3.2.0": {
    "node_abi": 45,
    "v8": "4.4"
  },
  "3.3.0": {
    "node_abi": 45,
    "v8": "4.4"
  },
  "3.3.1": {
    "node_abi": 45,
    "v8": "4.4"
  },
  "4.0.0": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.1.0": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.1.1": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.1.2": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.2.0": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.2.1": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.2.2": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.2.3": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.2.4": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.2.5": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.2.6": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.3.0": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.3.1": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.3.2": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.0": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.1": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.2": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.3": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.4": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.5": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.6": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.4.7": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.5.0": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.6.0": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "4.6.1": {
    "node_abi": 46,
    "v8": "4.5"
  },
  "5.0.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.1.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.1.1": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.2.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.3.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.4.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.4.1": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.5.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.6.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.7.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.7.1": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.8.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.9.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.9.1": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.10.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.10.1": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.11.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.11.1": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "5.12.0": {
    "node_abi": 47,
    "v8": "4.6"
  },
  "6.0.0": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.1.0": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.2.0": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.2.1": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.2.2": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.3.0": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.3.1": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.4.0": {
    "node_abi": 48,
    "v8": "5.0"
  },
  "6.5.0": {
    "node_abi": 48,
    "v8": "5.1"
  },
  "6.6.0": {
    "node_abi": 48,
    "v8": "5.1"
  },
  "6.7.0": {
    "node_abi": 48,
    "v8": "5.1"
  },
  "6.8.0": {
    "node_abi": 48,
    "v8": "5.1"
  },
  "6.8.1": {
    "node_abi": 48,
    "v8": "5.1"
  },
  "6.9.0": {
    "node_abi": 48,
    "v8": "5.1"
  },
  "6.9.1": {
    "node_abi": 48,
    "v8": "5.1"
  }
}
},{}],30:[function(_dereq_,module,exports){
(function (process){
"use strict";

module.exports = exports;

var path = _dereq_('path');
var semver = _dereq_('semver');
var url = _dereq_('url');

var abi_crosswalk;

// This is used for unit testing to provide a fake
// ABI crosswalk that emulates one that is not updated
// for the current version
if (process.env.NODE_PRE_GYP_ABI_CROSSWALK) {
    abi_crosswalk = _dereq_(process.env.NODE_PRE_GYP_ABI_CROSSWALK);
} else {
    abi_crosswalk = _dereq_('./abi_crosswalk.json');
}

function get_electron_abi(runtime, target_version) {
    if (!runtime) {
        throw new Error("get_electron_abi requires valid runtime arg");
    }
    if (typeof target_version === 'undefined') {
        // erroneous CLI call
        throw new Error("Empty target version is not supported if electron is the target.");
    }
    // Electron guarantees that patch version update won't break native modules.
    var sem_ver = semver.parse(target_version);
    return runtime + '-v' + sem_ver.major + '.' + sem_ver.minor;
}
module.exports.get_electron_abi = get_electron_abi;

function get_node_webkit_abi(runtime, target_version) {
    if (!runtime) {
        throw new Error("get_node_webkit_abi requires valid runtime arg");
    }
    if (typeof target_version === 'undefined') {
        // erroneous CLI call
        throw new Error("Empty target version is not supported if node-webkit is the target.");
    }
    return runtime + '-v' + target_version;
}
module.exports.get_node_webkit_abi = get_node_webkit_abi;

function get_node_abi(runtime, versions) {
    if (!runtime) {
        throw new Error("get_node_abi requires valid runtime arg");
    }
    if (!versions) {
        throw new Error("get_node_abi requires valid process.versions object");
    }
    var sem_ver = semver.parse(versions.node);
    if (sem_ver.major === 0 && sem_ver.minor % 2) { // odd series
        // https://github.com/mapbox/node-pre-gyp/issues/124
        return runtime+'-v'+versions.node;
    } else {
        // process.versions.modules added in >= v0.10.4 and v0.11.7
        // https://github.com/joyent/node/commit/ccabd4a6fa8a6eb79d29bc3bbe9fe2b6531c2d8e
        return versions.modules ? runtime+'-v' + (+versions.modules) :
            'v8-' + versions.v8.split('.').slice(0,2).join('.');
    }
}
module.exports.get_node_abi = get_node_abi;

function get_runtime_abi(runtime, target_version) {
    if (!runtime) {
        throw new Error("get_runtime_abi requires valid runtime arg");
    }
    if (runtime === 'node-webkit') {
        return get_node_webkit_abi(runtime, target_version || process.versions['node-webkit']);
    } else if (runtime === 'electron') {
        return get_electron_abi(runtime, target_version || process.versions.electron);
    } else {
        if (runtime != 'node') {
            throw new Error("Unknown Runtime: '" + runtime + "'");
        }
        if (!target_version) {
            return get_node_abi(runtime,process.versions);
        } else {
            var cross_obj;
            // abi_crosswalk generated with ./scripts/abi_crosswalk.js
            if (abi_crosswalk[target_version]) {
                cross_obj = abi_crosswalk[target_version];
            } else {
                var target_parts = target_version.split('.').map(function(i) { return +i; });
                if (target_parts.length != 3) { // parse failed
                    throw new Error("Unknown target version: " + target_version);
                }
                /*
                    The below code tries to infer the last known ABI compatible version
                    that we have recorded in the abi_crosswalk.json when an exact match
                    is not possible. The reasons for this to exist are complicated:

                       - We support passing --target to be able to allow developers to package binaries for versions of node
                         that are not the same one as they are running. This might also be used in combination with the
                         --target_arch or --target_platform flags to also package binaries for alternative platforms
                       - When --target is passed we can't therefore determine the ABI (process.versions.modules) from the node
                         version that is running in memory
                       - So, therefore node-pre-gyp keeps an "ABI crosswalk" (lib/util/abi_crosswalk.json) to be able to look
                         this info up for all versions
                       - But we cannot easily predict what the future ABI will be for released versions
                       - And node-pre-gyp needs to be a `bundledDependency` in apps that depend on it in order to work correctly
                         by being fully available at install time.
                       - So, the speed of node releases and the bundled nature of node-pre-gyp mean that a new node-pre-gyp release
                         need to happen for every node.js/io.js/node-webkit/nw.js/atom-shell/etc release that might come online if
                         you want the `--target` flag to keep working for the latest version
                       - Which is impractical ^^
                       - Hence the below code guesses about future ABI to make the need to update node-pre-gyp less demanding.

                    In practice then you can have a dependency of your app like `node-sqlite3` that bundles a `node-pre-gyp` that
                    only knows about node v0.10.33 in the `abi_crosswalk.json` but target node v0.10.34 (which is assumed to be
                    ABI compatible with v0.10.33).

                    TODO: use semver module instead of custom version parsing
                */
                var major = target_parts[0];
                var minor = target_parts[1];
                var patch = target_parts[2];
                // io.js: yeah if node.js ever releases 1.x this will break
                // but that is unlikely to happen: https://github.com/iojs/io.js/pull/253#issuecomment-69432616
                if (major === 1) {
                    // look for last release that is the same major version
                    // e.g. we assume io.js 1.x is ABI compatible with >= 1.0.0
                    while (true) {
                        if (minor > 0) --minor;
                        if (patch > 0) --patch;
                        var new_iojs_target = '' + major + '.' + minor + '.' + patch;
                        if (abi_crosswalk[new_iojs_target]) {
                            cross_obj = abi_crosswalk[new_iojs_target];
                            console.log('Warning: node-pre-gyp could not find exact match for ' + target_version);
                            console.log('Warning: but node-pre-gyp successfully choose ' + new_iojs_target + ' as ABI compatible target');
                            break;
                        }
                        if (minor === 0 && patch === 0) {
                            break;
                        }
                    }
                } else if (major === 0) { // node.js
                    if (target_parts[1] % 2 === 0) { // for stable/even node.js series
                        // look for the last release that is the same minor release
                        // e.g. we assume node 0.10.x is ABI compatible with >= 0.10.0
                        while (--patch > 0) {
                            var new_node_target = '' + major + '.' + minor + '.' + patch;
                            if (abi_crosswalk[new_node_target]) {
                                cross_obj = abi_crosswalk[new_node_target];
                                console.log('Warning: node-pre-gyp could not find exact match for ' + target_version);
                                console.log('Warning: but node-pre-gyp successfully choose ' + new_node_target + ' as ABI compatible target');
                                break;
                            }
                        }
                    }
                }
            }
            if (!cross_obj) {
                throw new Error("Unsupported target version: " + target_version);
            }
            // emulate process.versions
            var versions_obj = {
                node: target_version,
                v8: cross_obj.v8+'.0',
                // abi_crosswalk uses 1 for node versions lacking process.versions.modules
                // process.versions.modules added in >= v0.10.4 and v0.11.7
                modules: cross_obj.node_abi > 1 ? cross_obj.node_abi : undefined
            };
            return get_node_abi(runtime, versions_obj);
        }
    }
}
module.exports.get_runtime_abi = get_runtime_abi;

var required_parameters = [
    'module_name',
    'module_path',
    'host'
];

function validate_config(package_json) {
    var msg = package_json.name + ' package.json is not node-pre-gyp ready:\n';
    var missing = [];
    if (!package_json.main) {
        missing.push('main');
    }
    if (!package_json.version) {
        missing.push('version');
    }
    if (!package_json.name) {
        missing.push('name');
    }
    if (!package_json.binary) {
        missing.push('binary');
    }
    var o = package_json.binary;
    required_parameters.forEach(function(p) {
        if (missing.indexOf('binary') > -1) {
            missing.pop('binary');
        }
        if (!o || o[p] === undefined) {
            missing.push('binary.' + p);
        }
    });
    if (missing.length >= 1) {
        throw new Error(msg+"package.json must declare these properties: \n" + missing.join('\n'));
    }
    if (o) {
        // enforce https over http
        var protocol = url.parse(o.host).protocol;
        if (protocol === 'http:') {
            throw new Error("'host' protocol ("+protocol+") is invalid - only 'https:' is accepted");
        }
    }
}

module.exports.validate_config = validate_config;

function eval_template(template,opts) {
    Object.keys(opts).forEach(function(key) {
        var pattern = '{'+key+'}';
        while (template.indexOf(pattern) > -1) {
            template = template.replace(pattern,opts[key]);
        }
    });
    return template;
}

// url.resolve needs single trailing slash
// to behave correctly, otherwise a double slash
// may end up in the url which breaks requests
// and a lacking slash may not lead to proper joining
function fix_slashes(pathname) {
    if (pathname.slice(-1) != '/') {
        return pathname + '/';
    }
    return pathname;
}

// remove double slashes
// note: path.normalize will not work because
// it will convert forward to back slashes
function drop_double_slashes(pathname) {
    return pathname.replace(/\/\//g,'/');
}

function get_process_runtime(versions) {
    var runtime = 'node';
    if (versions['node-webkit']) {
        runtime = 'node-webkit';
    } else if (versions.electron) {
        runtime = 'electron';
    }
    return runtime;
}

module.exports.get_process_runtime = get_process_runtime;

var default_package_name = '{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz';
var default_remote_path = '';

module.exports.evaluate = function(package_json,options) {
    options = options || {};
    validate_config(package_json);
    var v = package_json.version;
    var module_version = semver.parse(v);
    var runtime = options.runtime || get_process_runtime(process.versions);
    var opts = {
        name: package_json.name,
        configuration: Boolean(options.debug) ? 'Debug' : 'Release',
        debug: options.debug,
        module_name: package_json.binary.module_name,
        version: module_version.version,
        prerelease: module_version.prerelease.length ? module_version.prerelease.join('.') : '',
        build: module_version.build.length ? module_version.build.join('.') : '',
        major: module_version.major,
        minor: module_version.minor,
        patch: module_version.patch,
        runtime: runtime,
        node_abi: get_runtime_abi(runtime,options.target),
        target: options.target || '',
        platform: options.target_platform || process.platform,
        target_platform: options.target_platform || process.platform,
        arch: options.target_arch || process.arch,
        target_arch: options.target_arch || process.arch,
        module_main: package_json.main,
        toolset : options.toolset || '' // address https://github.com/mapbox/node-pre-gyp/issues/119
    };
    // support host mirror with npm config `--{module_name}_binary_host_mirror`
    // e.g.: https://github.com/node-inspector/v8-profiler/blob/master/package.json#L25
    // > npm install v8-profiler --profiler_binary_host_mirror=https://npm.taobao.org/mirrors/node-inspector/
    var host = process.env['npm_config_' + opts.module_name + '_binary_host_mirror'] || package_json.binary.host;
    opts.host = fix_slashes(eval_template(host,opts));
    opts.module_path = eval_template(package_json.binary.module_path,opts);
    // now we resolve the module_path to ensure it is absolute so that binding.gyp variables work predictably
    if (options.module_root) {
        // resolve relative to known module root: works for pre-binding require
        opts.module_path = path.join(options.module_root,opts.module_path);
    } else {
        // resolve relative to current working directory: works for node-pre-gyp commands
        opts.module_path = path.resolve(opts.module_path);
    }
    opts.module = path.join(opts.module_path,opts.module_name + '.node');
    opts.remote_path = package_json.binary.remote_path ? drop_double_slashes(fix_slashes(eval_template(package_json.binary.remote_path,opts))) : default_remote_path;
    var package_name = package_json.binary.package_name ? package_json.binary.package_name : default_package_name;
    opts.package_name = eval_template(package_name,opts);
    opts.staged_tarball = path.join('build/stage',opts.remote_path,opts.package_name);
    opts.hosted_path = url.resolve(opts.host,opts.remote_path);
    opts.hosted_tarball = url.resolve(opts.hosted_path,opts.package_name);
    return opts;
};

}).call(this,_dereq_('_process'))
},{"./abi_crosswalk.json":29,"_process":20,"path":18,"semver":84,"url":100}],31:[function(_dereq_,module,exports){
(function (process){
// info about each config option.

var debug = process.env.DEBUG_NOPT || process.env.NOPT_DEBUG
  ? function () { console.error.apply(console, arguments) }
  : function () {}

var url = _dereq_("url")
  , path = _dereq_("path")
  , Stream = _dereq_("stream").Stream
  , abbrev = _dereq_("abbrev")

module.exports = exports = nopt
exports.clean = clean

exports.typeDefs =
  { String  : { type: String,  validate: validateString  }
  , Boolean : { type: Boolean, validate: validateBoolean }
  , url     : { type: url,     validate: validateUrl     }
  , Number  : { type: Number,  validate: validateNumber  }
  , path    : { type: path,    validate: validatePath    }
  , Stream  : { type: Stream,  validate: validateStream  }
  , Date    : { type: Date,    validate: validateDate    }
  }

function nopt (types, shorthands, args, slice) {
  args = args || process.argv
  types = types || {}
  shorthands = shorthands || {}
  if (typeof slice !== "number") slice = 2

  debug(types, shorthands, args, slice)

  args = args.slice(slice)
  var data = {}
    , key
    , remain = []
    , cooked = args
    , original = args.slice(0)

  parse(args, data, remain, types, shorthands)
  // now data is full
  clean(data, types, exports.typeDefs)
  data.argv = {remain:remain,cooked:cooked,original:original}
  Object.defineProperty(data.argv, 'toString', { value: function () {
    return this.original.map(JSON.stringify).join(" ")
  }, enumerable: false })
  return data
}

function clean (data, types, typeDefs) {
  typeDefs = typeDefs || exports.typeDefs
  var remove = {}
    , typeDefault = [false, true, null, String, Array]

  Object.keys(data).forEach(function (k) {
    if (k === "argv") return
    var val = data[k]
      , isArray = Array.isArray(val)
      , type = types[k]
    if (!isArray) val = [val]
    if (!type) type = typeDefault
    if (type === Array) type = typeDefault.concat(Array)
    if (!Array.isArray(type)) type = [type]

    debug("val=%j", val)
    debug("types=", type)
    val = val.map(function (val) {
      // if it's an unknown value, then parse false/true/null/numbers/dates
      if (typeof val === "string") {
        debug("string %j", val)
        val = val.trim()
        if ((val === "null" && ~type.indexOf(null))
            || (val === "true" &&
               (~type.indexOf(true) || ~type.indexOf(Boolean)))
            || (val === "false" &&
               (~type.indexOf(false) || ~type.indexOf(Boolean)))) {
          val = JSON.parse(val)
          debug("jsonable %j", val)
        } else if (~type.indexOf(Number) && !isNaN(val)) {
          debug("convert to number", val)
          val = +val
        } else if (~type.indexOf(Date) && !isNaN(Date.parse(val))) {
          debug("convert to date", val)
          val = new Date(val)
        }
      }

      if (!types.hasOwnProperty(k)) {
        return val
      }

      // allow `--no-blah` to set 'blah' to null if null is allowed
      if (val === false && ~type.indexOf(null) &&
          !(~type.indexOf(false) || ~type.indexOf(Boolean))) {
        val = null
      }

      var d = {}
      d[k] = val
      debug("prevalidated val", d, val, types[k])
      if (!validate(d, k, val, types[k], typeDefs)) {
        if (exports.invalidHandler) {
          exports.invalidHandler(k, val, types[k], data)
        } else if (exports.invalidHandler !== false) {
          debug("invalid: "+k+"="+val, types[k])
        }
        return remove
      }
      debug("validated val", d, val, types[k])
      return d[k]
    }).filter(function (val) { return val !== remove })

    if (!val.length) delete data[k]
    else if (isArray) {
      debug(isArray, data[k], val)
      data[k] = val
    } else data[k] = val[0]

    debug("k=%s val=%j", k, val, data[k])
  })
}

function validateString (data, k, val) {
  data[k] = String(val)
}

function validatePath (data, k, val) {
  if (val === true) return false
  if (val === null) return true

  val = String(val)
  var homePattern = process.platform === 'win32' ? /^~(\/|\\)/ : /^~\//
  if (val.match(homePattern) && process.env.HOME) {
    val = path.resolve(process.env.HOME, val.substr(2))
  }
  data[k] = path.resolve(String(val))
  return true
}

function validateNumber (data, k, val) {
  debug("validate Number %j %j %j", k, val, isNaN(val))
  if (isNaN(val)) return false
  data[k] = +val
}

function validateDate (data, k, val) {
  debug("validate Date %j %j %j", k, val, Date.parse(val))
  var s = Date.parse(val)
  if (isNaN(s)) return false
  data[k] = new Date(val)
}

function validateBoolean (data, k, val) {
  if (val instanceof Boolean) val = val.valueOf()
  else if (typeof val === "string") {
    if (!isNaN(val)) val = !!(+val)
    else if (val === "null" || val === "false") val = false
    else val = true
  } else val = !!val
  data[k] = val
}

function validateUrl (data, k, val) {
  val = url.parse(String(val))
  if (!val.host) return false
  data[k] = val.href
}

function validateStream (data, k, val) {
  if (!(val instanceof Stream)) return false
  data[k] = val
}

function validate (data, k, val, type, typeDefs) {
  // arrays are lists of types.
  if (Array.isArray(type)) {
    for (var i = 0, l = type.length; i < l; i ++) {
      if (type[i] === Array) continue
      if (validate(data, k, val, type[i], typeDefs)) return true
    }
    delete data[k]
    return false
  }

  // an array of anything?
  if (type === Array) return true

  // NaN is poisonous.  Means that something is not allowed.
  if (type !== type) {
    debug("Poison NaN", k, val, type)
    delete data[k]
    return false
  }

  // explicit list of values
  if (val === type) {
    debug("Explicitly allowed %j", val)
    // if (isArray) (data[k] = data[k] || []).push(val)
    // else data[k] = val
    data[k] = val
    return true
  }

  // now go through the list of typeDefs, validate against each one.
  var ok = false
    , types = Object.keys(typeDefs)
  for (var i = 0, l = types.length; i < l; i ++) {
    debug("test type %j %j %j", k, val, types[i])
    var t = typeDefs[types[i]]
    if (t &&
      ((type && type.name && t.type && t.type.name) ? (type.name === t.type.name) : (type === t.type))) {
      var d = {}
      ok = false !== t.validate(d, k, val)
      val = d[k]
      if (ok) {
        // if (isArray) (data[k] = data[k] || []).push(val)
        // else data[k] = val
        data[k] = val
        break
      }
    }
  }
  debug("OK? %j (%j %j %j)", ok, k, val, types[i])

  if (!ok) delete data[k]
  return ok
}

function parse (args, data, remain, types, shorthands) {
  debug("parse", args, data, remain)

  var key = null
    , abbrevs = abbrev(Object.keys(types))
    , shortAbbr = abbrev(Object.keys(shorthands))

  for (var i = 0; i < args.length; i ++) {
    var arg = args[i]
    debug("arg", arg)

    if (arg.match(/^-{2,}$/)) {
      // done with keys.
      // the rest are args.
      remain.push.apply(remain, args.slice(i + 1))
      args[i] = "--"
      break
    }
    var hadEq = false
    if (arg.charAt(0) === "-" && arg.length > 1) {
      if (arg.indexOf("=") !== -1) {
        hadEq = true
        var v = arg.split("=")
        arg = v.shift()
        v = v.join("=")
        args.splice.apply(args, [i, 1].concat([arg, v]))
      }

      // see if it's a shorthand
      // if so, splice and back up to re-parse it.
      var shRes = resolveShort(arg, shorthands, shortAbbr, abbrevs)
      debug("arg=%j shRes=%j", arg, shRes)
      if (shRes) {
        debug(arg, shRes)
        args.splice.apply(args, [i, 1].concat(shRes))
        if (arg !== shRes[0]) {
          i --
          continue
        }
      }
      arg = arg.replace(/^-+/, "")
      var no = null
      while (arg.toLowerCase().indexOf("no-") === 0) {
        no = !no
        arg = arg.substr(3)
      }

      if (abbrevs[arg]) arg = abbrevs[arg]

      var isArray = types[arg] === Array ||
        Array.isArray(types[arg]) && types[arg].indexOf(Array) !== -1

      // allow unknown things to be arrays if specified multiple times.
      if (!types.hasOwnProperty(arg) && data.hasOwnProperty(arg)) {
        if (!Array.isArray(data[arg]))
          data[arg] = [data[arg]]
        isArray = true
      }

      var val
        , la = args[i + 1]

      var isBool = typeof no === 'boolean' ||
        types[arg] === Boolean ||
        Array.isArray(types[arg]) && types[arg].indexOf(Boolean) !== -1 ||
        (typeof types[arg] === 'undefined' && !hadEq) ||
        (la === "false" &&
         (types[arg] === null ||
          Array.isArray(types[arg]) && ~types[arg].indexOf(null)))

      if (isBool) {
        // just set and move along
        val = !no
        // however, also support --bool true or --bool false
        if (la === "true" || la === "false") {
          val = JSON.parse(la)
          la = null
          if (no) val = !val
          i ++
        }

        // also support "foo":[Boolean, "bar"] and "--foo bar"
        if (Array.isArray(types[arg]) && la) {
          if (~types[arg].indexOf(la)) {
            // an explicit type
            val = la
            i ++
          } else if ( la === "null" && ~types[arg].indexOf(null) ) {
            // null allowed
            val = null
            i ++
          } else if ( !la.match(/^-{2,}[^-]/) &&
                      !isNaN(la) &&
                      ~types[arg].indexOf(Number) ) {
            // number
            val = +la
            i ++
          } else if ( !la.match(/^-[^-]/) && ~types[arg].indexOf(String) ) {
            // string
            val = la
            i ++
          }
        }

        if (isArray) (data[arg] = data[arg] || []).push(val)
        else data[arg] = val

        continue
      }

      if (types[arg] === String && la === undefined)
        la = ""

      if (la && la.match(/^-{2,}$/)) {
        la = undefined
        i --
      }

      val = la === undefined ? true : la
      if (isArray) (data[arg] = data[arg] || []).push(val)
      else data[arg] = val

      i ++
      continue
    }
    remain.push(arg)
  }
}

function resolveShort (arg, shorthands, shortAbbr, abbrevs) {
  // handle single-char shorthands glommed together, like
  // npm ls -glp, but only if there is one dash, and only if
  // all of the chars are single-char shorthands, and it's
  // not a match to some other abbrev.
  arg = arg.replace(/^-+/, '')

  // if it's an exact known option, then don't go any further
  if (abbrevs[arg] === arg)
    return null

  // if it's an exact known shortopt, same deal
  if (shorthands[arg]) {
    // make it an array, if it's a list of words
    if (shorthands[arg] && !Array.isArray(shorthands[arg]))
      shorthands[arg] = shorthands[arg].split(/\s+/)

    return shorthands[arg]
  }

  // first check to see if this arg is a set of single-char shorthands
  var singles = shorthands.___singles
  if (!singles) {
    singles = Object.keys(shorthands).filter(function (s) {
      return s.length === 1
    }).reduce(function (l,r) {
      l[r] = true
      return l
    }, {})
    shorthands.___singles = singles
    debug('shorthand singles', singles)
  }

  var chrs = arg.split("").filter(function (c) {
    return singles[c]
  })

  if (chrs.join("") === arg) return chrs.map(function (c) {
    return shorthands[c]
  }).reduce(function (l, r) {
    return l.concat(r)
  }, [])


  // if it's an arg abbrev, and not a literal shorthand, then prefer the arg
  if (abbrevs[arg] && !shorthands[arg])
    return null

  // if it's an abbr for a shorthand, then use that
  if (shortAbbr[arg])
    arg = shortAbbr[arg]

  // make it an array, if it's a list of words
  if (shorthands[arg] && !Array.isArray(shorthands[arg]))
    shorthands[arg] = shorthands[arg].split(/\s+/)

  return shorthands[arg]
}

}).call(this,_dereq_('_process'))
},{"_process":20,"abbrev":32,"path":18,"stream":86,"url":100}],32:[function(_dereq_,module,exports){

module.exports = exports = abbrev.abbrev = abbrev

abbrev.monkeyPatch = monkeyPatch

function monkeyPatch () {
  Object.defineProperty(Array.prototype, 'abbrev', {
    value: function () { return abbrev(this) },
    enumerable: false, configurable: true, writable: true
  })

  Object.defineProperty(Object.prototype, 'abbrev', {
    value: function () { return abbrev(Object.keys(this)) },
    enumerable: false, configurable: true, writable: true
  })
}

function abbrev (list) {
  if (arguments.length !== 1 || !Array.isArray(list)) {
    list = Array.prototype.slice.call(arguments, 0)
  }
  for (var i = 0, l = list.length, args = [] ; i < l ; i ++) {
    args[i] = typeof list[i] === "string" ? list[i] : String(list[i])
  }

  // sort them lexicographically, so that they're next to their nearest kin
  args = args.sort(lexSort)

  // walk through each, seeing how much it has in common with the next and previous
  var abbrevs = {}
    , prev = ""
  for (var i = 0, l = args.length ; i < l ; i ++) {
    var current = args[i]
      , next = args[i + 1] || ""
      , nextMatches = true
      , prevMatches = true
    if (current === next) continue
    for (var j = 0, cl = current.length ; j < cl ; j ++) {
      var curChar = current.charAt(j)
      nextMatches = nextMatches && curChar === next.charAt(j)
      prevMatches = prevMatches && curChar === prev.charAt(j)
      if (!nextMatches && !prevMatches) {
        j ++
        break
      }
    }
    prev = current
    if (j === cl) {
      abbrevs[current] = current
      continue
    }
    for (var a = current.substr(0, j) ; j <= cl ; j ++) {
      abbrevs[a] = current
      a += current.charAt(j)
    }
  }
  return abbrevs
}

function lexSort (a, b) {
  return a === b ? 0 : a > b ? 1 : -1
}

},{}],33:[function(_dereq_,module,exports){
(function (process){
'use strict'
var Progress = _dereq_('are-we-there-yet')
var Gauge = _dereq_('gauge')
var EE = _dereq_('events').EventEmitter
var log = exports = module.exports = new EE()
var util = _dereq_('util')

var setBlocking = _dereq_('set-blocking')
var consoleControl = _dereq_('console-control-strings')

setBlocking(true)
var stream = process.stderr
Object.defineProperty(log, 'stream', {
  set: function (newStream) {
    stream = newStream
    if (this.gauge) this.gauge.setWriteTo(stream, stream)
  },
  get: function () {
    return stream
  }
})

// by default, decide based on tty-ness.
var colorEnabled
log.useColor = function () {
  return colorEnabled != null ? colorEnabled : stream.isTTY
}

log.enableColor = function () {
  colorEnabled = true
  this.gauge.setTheme({hasColor: colorEnabled, hasUnicode: unicodeEnabled})
}
log.disableColor = function () {
  colorEnabled = false
  this.gauge.setTheme({hasColor: colorEnabled, hasUnicode: unicodeEnabled})
}

// default level
log.level = 'info'

log.gauge = new Gauge(stream, {
  theme: {hasColor: log.useColor()},
  template: [
    {type: 'progressbar', length: 20},
    {type: 'activityIndicator', kerning: 1, length: 1},
    {type: 'section', default: ''},
    ':',
    {type: 'logline', kerning: 1, default: ''}
  ]
})

log.tracker = new Progress.TrackerGroup()

// no progress bars unless asked
log.progressEnabled = false

var unicodeEnabled

log.enableUnicode = function () {
  unicodeEnabled = true
  this.gauge.setTheme({hasColor: this.useColor(), hasUnicode: unicodeEnabled})
}

log.disableUnicode = function () {
  unicodeEnabled = false
  this.gauge.setTheme({hasColor: this.useColor(), hasUnicode: unicodeEnabled})
}

log.setGaugeThemeset = function (themes) {
  this.gauge.setThemeset(themes)
}

log.setGaugeTemplate = function (template) {
  this.gauge.setTemplate(template)
}

log.enableProgress = function () {
  if (this.progressEnabled) return
  this.progressEnabled = true
  if (this._pause) return
  this.tracker.on('change', this.showProgress)
  this.gauge.enable()
  this.showProgress()
}

log.disableProgress = function () {
  if (!this.progressEnabled) return
  this.clearProgress()
  this.progressEnabled = false
  this.tracker.removeListener('change', this.showProgress)
  this.gauge.disable()
}

var trackerConstructors = ['newGroup', 'newItem', 'newStream']

var mixinLog = function (tracker) {
  // mixin the public methods from log into the tracker
  // (except: conflicts and one's we handle specially)
  Object.keys(log).forEach(function (P) {
    if (P[0] === '_') return
    if (trackerConstructors.filter(function (C) { return C === P }).length) return
    if (tracker[P]) return
    if (typeof log[P] !== 'function') return
    var func = log[P]
    tracker[P] = function () {
      return func.apply(log, arguments)
    }
  })
  // if the new tracker is a group, make sure any subtrackers get
  // mixed in too
  if (tracker instanceof Progress.TrackerGroup) {
    trackerConstructors.forEach(function (C) {
      var func = tracker[C]
      tracker[C] = function () { return mixinLog(func.apply(tracker, arguments)) }
    })
  }
  return tracker
}

// Add tracker constructors to the top level log object
trackerConstructors.forEach(function (C) {
  log[C] = function () { return mixinLog(this.tracker[C].apply(this.tracker, arguments)) }
})

log.clearProgress = function (cb) {
  if (!this.progressEnabled) return cb && process.nextTick(cb)
  this.gauge.hide(cb)
}

log.showProgress = function (name, completed) {
  if (!this.progressEnabled) return
  var values = {}
  if (name) values.section = name
  var last = log.record[log.record.length - 1]
  if (last) {
    values.subsection = last.prefix
    var disp = log.disp[last.level] || last.level
    var logline = this._format(disp, log.style[last.level])
    if (last.prefix) logline += ' ' + this._format(last.prefix, this.prefixStyle)
    logline += ' ' + last.message.split(/\r?\n/)[0]
    values.logline = logline
  }
  values.completed = completed || this.tracker.completed()
  this.gauge.show(values)
}.bind(log) // bind for use in tracker's on-change listener

// temporarily stop emitting, but don't drop
log.pause = function () {
  this._paused = true
}

log.resume = function () {
  if (!this._paused) return
  this._paused = false

  var b = this._buffer
  this._buffer = []
  b.forEach(function (m) {
    this.emitLog(m)
  }, this)
  if (this.progressEnabled) this.enableProgress()
}

log._buffer = []

var id = 0
log.record = []
log.maxRecordSize = 10000
log.log = function (lvl, prefix, message) {
  var l = this.levels[lvl]
  if (l === undefined) {
    return this.emit('error', new Error(util.format(
      'Undefined log level: %j', lvl)))
  }

  var a = new Array(arguments.length - 2)
  var stack = null
  for (var i = 2; i < arguments.length; i++) {
    var arg = a[i - 2] = arguments[i]

    // resolve stack traces to a plain string.
    if (typeof arg === 'object' && arg &&
        (arg instanceof Error) && arg.stack) {
      arg.stack = stack = arg.stack + ''
    }
  }
  if (stack) a.unshift(stack + '\n')
  message = util.format.apply(util, a)

  var m = { id: id++,
            level: lvl,
            prefix: String(prefix || ''),
            message: message,
            messageRaw: a }

  this.emit('log', m)
  this.emit('log.' + lvl, m)
  if (m.prefix) this.emit(m.prefix, m)

  this.record.push(m)
  var mrs = this.maxRecordSize
  var n = this.record.length - mrs
  if (n > mrs / 10) {
    var newSize = Math.floor(mrs * 0.9)
    this.record = this.record.slice(-1 * newSize)
  }

  this.emitLog(m)
}.bind(log)

log.emitLog = function (m) {
  if (this._paused) {
    this._buffer.push(m)
    return
  }
  if (this.progressEnabled) this.gauge.pulse(m.prefix)
  var l = this.levels[m.level]
  if (l === undefined) return
  if (l < this.levels[this.level]) return
  if (l > 0 && !isFinite(l)) return

  // If 'disp' is null or undefined, use the lvl as a default
  // Allows: '', 0 as valid disp
  var disp = log.disp[m.level] != null ? log.disp[m.level] : m.level
  this.clearProgress()
  m.message.split(/\r?\n/).forEach(function (line) {
    if (this.heading) {
      this.write(this.heading, this.headingStyle)
      this.write(' ')
    }
    this.write(disp, log.style[m.level])
    var p = m.prefix || ''
    if (p) this.write(' ')
    this.write(p, this.prefixStyle)
    this.write(' ' + line + '\n')
  }, this)
  this.showProgress()
}

log._format = function (msg, style) {
  if (!stream) return

  var output = ''
  if (this.useColor()) {
    style = style || {}
    var settings = []
    if (style.fg) settings.push(style.fg)
    if (style.bg) settings.push('bg' + style.bg[0].toUpperCase() + style.bg.slice(1))
    if (style.bold) settings.push('bold')
    if (style.underline) settings.push('underline')
    if (style.inverse) settings.push('inverse')
    if (settings.length) output += consoleControl.color(settings)
    if (style.beep) output += consoleControl.beep()
  }
  output += msg
  if (this.useColor()) {
    output += consoleControl.color('reset')
  }
  return output
}

log.write = function (msg, style) {
  if (!stream) return

  stream.write(this._format(msg, style))
}

log.addLevel = function (lvl, n, style, disp) {
  // If 'disp' is null or undefined, use the lvl as a default
  if (disp == null) disp = lvl
  this.levels[lvl] = n
  this.style[lvl] = style
  if (!this[lvl]) {
    this[lvl] = function () {
      var a = new Array(arguments.length + 1)
      a[0] = lvl
      for (var i = 0; i < arguments.length; i++) {
        a[i + 1] = arguments[i]
      }
      return this.log.apply(this, a)
    }.bind(this)
  }
  this.disp[lvl] = disp
}

log.prefixStyle = { fg: 'magenta' }
log.headingStyle = { fg: 'white', bg: 'black' }

log.style = {}
log.levels = {}
log.disp = {}
log.addLevel('silly', -Infinity, { inverse: true }, 'sill')
log.addLevel('verbose', 1000, { fg: 'blue', bg: 'black' }, 'verb')
log.addLevel('info', 2000, { fg: 'green' })
log.addLevel('http', 3000, { fg: 'green', bg: 'black' })
log.addLevel('warn', 4000, { fg: 'black', bg: 'yellow' }, 'WARN')
log.addLevel('error', 5000, { fg: 'red', bg: 'black' }, 'ERR!')
log.addLevel('silent', Infinity)

// allow 'error' prefix
log.on('error', function () {})

}).call(this,_dereq_('_process'))
},{"_process":20,"are-we-there-yet":34,"console-control-strings":54,"events":11,"gauge":58,"set-blocking":83,"util":104}],34:[function(_dereq_,module,exports){
'use strict'
exports.TrackerGroup = _dereq_('./tracker-group.js')
exports.Tracker = _dereq_('./tracker.js')
exports.TrackerStream = _dereq_('./tracker-stream.js')

},{"./tracker-group.js":51,"./tracker-stream.js":52,"./tracker.js":53}],35:[function(_dereq_,module,exports){

/**
 * Expose `Delegator`.
 */

module.exports = Delegator;

/**
 * Initialize a delegator.
 *
 * @param {Object} proto
 * @param {String} target
 * @api public
 */

function Delegator(proto, target) {
  if (!(this instanceof Delegator)) return new Delegator(proto, target);
  this.proto = proto;
  this.target = target;
  this.methods = [];
  this.getters = [];
  this.setters = [];
  this.fluents = [];
}

/**
 * Delegate method `name`.
 *
 * @param {String} name
 * @return {Delegator} self
 * @api public
 */

Delegator.prototype.method = function(name){
  var proto = this.proto;
  var target = this.target;
  this.methods.push(name);

  proto[name] = function(){
    return this[target][name].apply(this[target], arguments);
  };

  return this;
};

/**
 * Delegator accessor `name`.
 *
 * @param {String} name
 * @return {Delegator} self
 * @api public
 */

Delegator.prototype.access = function(name){
  return this.getter(name).setter(name);
};

/**
 * Delegator getter `name`.
 *
 * @param {String} name
 * @return {Delegator} self
 * @api public
 */

Delegator.prototype.getter = function(name){
  var proto = this.proto;
  var target = this.target;
  this.getters.push(name);

  proto.__defineGetter__(name, function(){
    return this[target][name];
  });

  return this;
};

/**
 * Delegator setter `name`.
 *
 * @param {String} name
 * @return {Delegator} self
 * @api public
 */

Delegator.prototype.setter = function(name){
  var proto = this.proto;
  var target = this.target;
  this.setters.push(name);

  proto.__defineSetter__(name, function(val){
    return this[target][name] = val;
  });

  return this;
};

/**
 * Delegator fluent accessor
 *
 * @param {String} name
 * @return {Delegator} self
 * @api public
 */

Delegator.prototype.fluent = function (name) {
  var proto = this.proto;
  var target = this.target;
  this.fluents.push(name);

  proto[name] = function(val){
    if ('undefined' != typeof val) {
      this[target][name] = val;
      return this;
    } else {
      return this[target][name];
    }
  };

  return this;
};

},{}],36:[function(_dereq_,module,exports){
// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

'use strict';

/*<replacement>*/

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    keys.push(key);
  }return keys;
};
/*</replacement>*/

module.exports = Duplex;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

var Readable = _dereq_('./_stream_readable');
var Writable = _dereq_('./_stream_writable');

util.inherits(Duplex, Readable);

var keys = objectKeys(Writable.prototype);
for (var v = 0; v < keys.length; v++) {
  var method = keys[v];
  if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
}

function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false) this.readable = false;

  if (options && options.writable === false) this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false) this.allowHalfOpen = false;

  this.once('end', onend);
}

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended) return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  processNextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

function forEach(xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}
},{"./_stream_readable":38,"./_stream_writable":40,"core-util-is":43,"inherits":44,"process-nextick-args":46}],37:[function(_dereq_,module,exports){
// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

'use strict';

module.exports = PassThrough;

var Transform = _dereq_('./_stream_transform');

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};
},{"./_stream_transform":39,"core-util-is":43,"inherits":44}],38:[function(_dereq_,module,exports){
(function (process){
'use strict';

module.exports = Readable;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var isArray = _dereq_('isarray');
/*</replacement>*/

Readable.ReadableState = ReadableState;

/*<replacement>*/
var EE = _dereq_('events').EventEmitter;

var EElistenerCount = function (emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

/*<replacement>*/
var Stream;
(function () {
  try {
    Stream = _dereq_('st' + 'ream');
  } catch (_) {} finally {
    if (!Stream) Stream = _dereq_('events').EventEmitter;
  }
})();
/*</replacement>*/

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

/*<replacement>*/
var debugUtil = _dereq_('util');
var debug = void 0;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var BufferList = _dereq_('./internal/streams/BufferList');
var StringDecoder;

util.inherits(Readable, Stream);

function prependListener(emitter, event, fn) {
  if (typeof emitter.prependListener === 'function') {
    return emitter.prependListener(event, fn);
  } else {
    // This is a hack to make sure that our error handler is attached before any
    // userland ones.  NEVER DO THIS. This is here only because this code needs
    // to continue to work with older versions of Node.js that do not include
    // the prependListener() method. The goal is to eventually remove this hack.
    if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);else if (isArray(emitter._events[event])) emitter._events[event].unshift(fn);else emitter._events[event] = [fn, emitter._events[event]];
  }
}

var Duplex;
function ReadableState(options, stream) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  options = options || {};

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex) this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~ ~this.highWaterMark;

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()
  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // when piping, we only care about 'readable' events that happen
  // after read()ing all the bytes and not getting any pushback.
  this.ranOut = false;

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder) StringDecoder = _dereq_('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

var Duplex;
function Readable(options) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  if (!(this instanceof Readable)) return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options && typeof options.read === 'function') this._read = options.read;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  var state = this._readableState;

  if (!state.objectMode && typeof chunk === 'string') {
    encoding = encoding || state.defaultEncoding;
    if (encoding !== state.encoding) {
      chunk = bufferShim.from(chunk, encoding);
      encoding = '';
    }
  }

  return readableAddChunk(this, state, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function (chunk) {
  var state = this._readableState;
  return readableAddChunk(this, state, chunk, '', true);
};

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || chunk && chunk.length > 0) {
    if (state.ended && !addToFront) {
      var e = new Error('stream.push() after EOF');
      stream.emit('error', e);
    } else if (state.endEmitted && addToFront) {
      var _e = new Error('stream.unshift() after end event');
      stream.emit('error', _e);
    } else {
      var skipAdd;
      if (state.decoder && !addToFront && !encoding) {
        chunk = state.decoder.write(chunk);
        skipAdd = !state.objectMode && chunk.length === 0;
      }

      if (!addToFront) state.reading = false;

      // Don't add to the buffer if we've decoded to an empty string chunk and
      // we're not in object mode
      if (!skipAdd) {
        // if we want the data now, just emit it.
        if (state.flowing && state.length === 0 && !state.sync) {
          stream.emit('data', chunk);
          stream.read(0);
        } else {
          // update the buffer info.
          state.length += state.objectMode ? 1 : chunk.length;
          if (addToFront) state.buffer.unshift(chunk);else state.buffer.push(chunk);

          if (state.needReadable) emitReadable(stream);
        }
      }

      maybeReadMore(stream, state);
    }
  } else if (!addToFront) {
    state.reading = false;
  }

  return needMoreData(state);
}

// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
}

// backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = _dereq_('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || state.length === 0 && state.ended) return 0;
  if (state.objectMode) return 1;
  if (n !== n) {
    // Only flow one buffer at a time
    if (state.flowing && state.length) return state.buffer.head.data.length;else return state.length;
  }
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n <= state.length) return n;
  // Don't have enough
  if (!state.ended) {
    state.needReadable = true;
    return 0;
  }
  return state.length;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  debug('read', n);
  n = parseInt(n, 10);
  var state = this._readableState;
  var nOrig = n;

  if (n !== 0) state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) endReadable(this);else emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0) ret = fromList(n, state);else ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  } else {
    state.length -= n;
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }

  if (ret !== null) this.emit('data', ret);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== null && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync) processNextTick(emitReadable_, stream);else emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}

// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    processNextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;else len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (n) {
  this.emit('error', new Error('not implemented'));
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted) processNextTick(endFn);else src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    debug('onunpipe');
    if (readable === src) {
      cleanup();
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain)) ondrain();
  }

  // If the user pushes more data while we're writing to dest then we'll end up
  // in ondata again. However, we only want to increase awaitDrain once because
  // dest will only emit one 'drain' event for the multiple writes.
  // => Introduce a guard on increasing awaitDrain.
  var increasedAwaitDrain = false;
  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    increasedAwaitDrain = false;
    var ret = dest.write(chunk);
    if (false === ret && !increasedAwaitDrain) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
        increasedAwaitDrain = true;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0) dest.emit('error', er);
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function () {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain) state.awaitDrain--;
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0) return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes) return this;

    if (!dest) dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest) dest.emit('unpipe', this);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var _i = 0; _i < len; _i++) {
      dests[_i].emit('unpipe', this);
    }return this;
  }

  // try to find the right one.
  var i = indexOf(state.pipes, dest);
  if (i === -1) return this;

  state.pipes.splice(i, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1) state.pipes = state.pipes[0];

  dest.emit('unpipe', this);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function (ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  if (ev === 'data') {
    // Start flowing on next tick if stream isn't explicitly paused
    if (this._readableState.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    var state = this._readableState;
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.emittedReadable = false;
      if (!state.reading) {
        processNextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function () {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    processNextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  state.awaitDrain = 0;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  while (state.flowing && stream.read() !== null) {}
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function () {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function (chunk) {
    debug('wrapped data');
    if (state.decoder) chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined)) return;else if (!state.objectMode && (!chunk || !chunk.length)) return;

    var ret = self.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function (method) {
        return function () {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  }

  // proxy certain important events.
  var events = ['error', 'close', 'destroy', 'pause', 'resume'];
  forEach(events, function (ev) {
    stream.on(ev, self.emit.bind(self, ev));
  });

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  self._read = function (n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return self;
};

// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered
  if (state.length === 0) return null;

  var ret;
  if (state.objectMode) ret = state.buffer.shift();else if (!n || n >= state.length) {
    // read it all, truncate the list
    if (state.decoder) ret = state.buffer.join('');else if (state.buffer.length === 1) ret = state.buffer.head.data;else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = fromListPartial(n, state.buffer, state.decoder);
  }

  return ret;
}

// Extracts only enough buffered data to satisfy the amount requested.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromListPartial(n, list, hasStrings) {
  var ret;
  if (n < list.head.data.length) {
    // slice is the same for buffers and strings
    ret = list.head.data.slice(0, n);
    list.head.data = list.head.data.slice(n);
  } else if (n === list.head.data.length) {
    // first chunk is a perfect match
    ret = list.shift();
  } else {
    // result spans more than one buffer
    ret = hasStrings ? copyFromBufferString(n, list) : copyFromBuffer(n, list);
  }
  return ret;
}

// Copies a specified amount of characters from the list of buffered data
// chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBufferString(n, list) {
  var p = list.head;
  var c = 1;
  var ret = p.data;
  n -= ret.length;
  while (p = p.next) {
    var str = p.data;
    var nb = n > str.length ? str.length : n;
    if (nb === str.length) ret += str;else ret += str.slice(0, n);
    n -= nb;
    if (n === 0) {
      if (nb === str.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = str.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

// Copies a specified amount of bytes from the list of buffered data chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBuffer(n, list) {
  var ret = bufferShim.allocUnsafe(n);
  var p = list.head;
  var c = 1;
  p.data.copy(ret);
  n -= p.data.length;
  while (p = p.next) {
    var buf = p.data;
    var nb = n > buf.length ? buf.length : n;
    buf.copy(ret, ret.length - n, 0, nb);
    n -= nb;
    if (n === 0) {
      if (nb === buf.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = buf.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0) throw new Error('"endReadable()" called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    processNextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function forEach(xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

function indexOf(xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}
}).call(this,_dereq_('_process'))
},{"./_stream_duplex":36,"./internal/streams/BufferList":41,"_process":20,"buffer":8,"buffer-shims":42,"core-util-is":43,"events":11,"inherits":44,"isarray":45,"process-nextick-args":46,"string_decoder/":47,"util":5}],39:[function(_dereq_,module,exports){
// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = _dereq_('./_stream_duplex');

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);

function TransformState(stream) {
  this.afterTransform = function (er, data) {
    return afterTransform(stream, er, data);
  };

  this.needTransform = false;
  this.transforming = false;
  this.writecb = null;
  this.writechunk = null;
  this.writeencoding = null;
}

function afterTransform(stream, er, data) {
  var ts = stream._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb) return stream.emit('error', new Error('no writecb in Transform class'));

  ts.writechunk = null;
  ts.writecb = null;

  if (data !== null && data !== undefined) stream.push(data);

  cb(er);

  var rs = stream._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    stream._read(rs.highWaterMark);
  }
}

function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);

  Duplex.call(this, options);

  this._transformState = new TransformState(this);

  // when the writable side finishes, then flush out anything remaining.
  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;

    if (typeof options.flush === 'function') this._flush = options.flush;
  }

  this.once('prefinish', function () {
    if (typeof this._flush === 'function') this._flush(function (er) {
      done(stream, er);
    });else done(stream);
  });
}

Transform.prototype.push = function (chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function (chunk, encoding, cb) {
  throw new Error('Not implemented');
};

Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark) this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function (n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};

function done(stream, er) {
  if (er) return stream.emit('error', er);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  var ws = stream._writableState;
  var ts = stream._transformState;

  if (ws.length) throw new Error('Calling transform done when ws.length != 0');

  if (ts.transforming) throw new Error('Calling transform done when still transforming');

  return stream.push(null);
}
},{"./_stream_duplex":36,"core-util-is":43,"inherits":44}],40:[function(_dereq_,module,exports){
(function (process){
// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

module.exports = Writable;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var asyncWrite = !process.browser && ['v0.10', 'v0.9.'].indexOf(process.version.slice(0, 5)) > -1 ? setImmediate : processNextTick;
/*</replacement>*/

Writable.WritableState = WritableState;

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

/*<replacement>*/
var internalUtil = {
  deprecate: _dereq_('util-deprecate')
};
/*</replacement>*/

/*<replacement>*/
var Stream;
(function () {
  try {
    Stream = _dereq_('st' + 'ream');
  } catch (_) {} finally {
    if (!Stream) Stream = _dereq_('events').EventEmitter;
  }
})();
/*</replacement>*/

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

util.inherits(Writable, Stream);

function nop() {}

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

var Duplex;
function WritableState(options, stream) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  options = options || {};

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex) this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~ ~this.highWaterMark;

  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function (er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;

  // count buffered requests
  this.bufferedRequestCount = 0;

  // allocate the first CorkedRequest, there is always
  // one allocated and free to use, and we maintain at most two
  this.corkedRequestsFree = new CorkedRequest(this);
}

WritableState.prototype.getBuffer = function writableStateGetBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function () {
  try {
    Object.defineProperty(WritableState.prototype, 'buffer', {
      get: internalUtil.deprecate(function () {
        return this.getBuffer();
      }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.')
    });
  } catch (_) {}
})();

var Duplex;
function Writable(options) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  // Writable ctor is applied to Duplexes, though they're not
  // instanceof Writable, they're instanceof Readable.
  if (!(this instanceof Writable) && !(this instanceof Duplex)) return new Writable(options);

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function') this._write = options.write;

    if (typeof options.writev === 'function') this._writev = options.writev;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function () {
  this.emit('error', new Error('Cannot pipe, not readable'));
};

function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  processNextTick(cb, er);
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  var er = false;
  // Always throw error if a null is written
  // if we are not in object mode then throw
  // if it is not a buffer, string, or undefined.
  if (chunk === null) {
    er = new TypeError('May not write null values to stream');
  } else if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  if (er) {
    stream.emit('error', er);
    processNextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function (chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (Buffer.isBuffer(chunk)) encoding = 'buffer';else if (!encoding) encoding = state.defaultEncoding;

  if (typeof cb !== 'function') cb = nop;

  if (state.ended) writeAfterEnd(this, cb);else if (validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function () {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.bufferedRequest) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string') encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1)) throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
    chunk = bufferShim.from(chunk, encoding);
  }
  return chunk;
}

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, chunk, encoding, cb) {
  chunk = decodeChunk(state, chunk, encoding);

  if (Buffer.isBuffer(chunk)) encoding = 'buffer';
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = new WriteReq(chunk, encoding, cb);
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
    state.bufferedRequestCount += 1;
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev) stream._writev(chunk, state.onwrite);else stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;
  if (sync) processNextTick(cb, er);else cb(er);

  stream._writableState.errorEmitted = true;
  stream.emit('error', er);
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er) onwriteError(stream, state, sync, er, cb);else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      /*<replacement>*/
      asyncWrite(afterWrite, stream, state, finished, cb);
      /*</replacement>*/
    } else {
        afterWrite(stream, state, finished, cb);
      }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished) onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}

// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var l = state.bufferedRequestCount;
    var buffer = new Array(l);
    var holder = state.corkedRequestsFree;
    holder.entry = entry;

    var count = 0;
    while (entry) {
      buffer[count] = entry;
      entry = entry.next;
      count += 1;
    }

    doWrite(stream, state, true, state.length, buffer, '', holder.finish);

    // doWrite is almost always async, defer these to save a bit of time
    // as the hot path ends with doWrite
    state.pendingcb++;
    state.lastBufferedRequest = null;
    if (holder.next) {
      state.corkedRequestsFree = holder.next;
      holder.next = null;
    } else {
      state.corkedRequestsFree = new CorkedRequest(state);
    }
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null) state.lastBufferedRequest = null;
  }

  state.bufferedRequestCount = 0;
  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new Error('not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function (chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished) endWritable(this, state, cb);
};

function needFinish(state) {
  return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
}

function prefinish(stream, state) {
  if (!state.prefinished) {
    state.prefinished = true;
    stream.emit('prefinish');
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    if (state.pendingcb === 0) {
      prefinish(stream, state);
      state.finished = true;
      stream.emit('finish');
    } else {
      prefinish(stream, state);
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished) processNextTick(cb);else stream.once('finish', cb);
  }
  state.ended = true;
  stream.writable = false;
}

// It seems a linked list but it is not
// there will be only 2 of these for each stream
function CorkedRequest(state) {
  var _this = this;

  this.next = null;
  this.entry = null;

  this.finish = function (err) {
    var entry = _this.entry;
    _this.entry = null;
    while (entry) {
      var cb = entry.callback;
      state.pendingcb--;
      cb(err);
      entry = entry.next;
    }
    if (state.corkedRequestsFree) {
      state.corkedRequestsFree.next = _this;
    } else {
      state.corkedRequestsFree = _this;
    }
  };
}
}).call(this,_dereq_('_process'))
},{"./_stream_duplex":36,"_process":20,"buffer":8,"buffer-shims":42,"core-util-is":43,"events":11,"inherits":44,"process-nextick-args":46,"util-deprecate":48}],41:[function(_dereq_,module,exports){
'use strict';

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

module.exports = BufferList;

function BufferList() {
  this.head = null;
  this.tail = null;
  this.length = 0;
}

BufferList.prototype.push = function (v) {
  var entry = { data: v, next: null };
  if (this.length > 0) this.tail.next = entry;else this.head = entry;
  this.tail = entry;
  ++this.length;
};

BufferList.prototype.unshift = function (v) {
  var entry = { data: v, next: this.head };
  if (this.length === 0) this.tail = entry;
  this.head = entry;
  ++this.length;
};

BufferList.prototype.shift = function () {
  if (this.length === 0) return;
  var ret = this.head.data;
  if (this.length === 1) this.head = this.tail = null;else this.head = this.head.next;
  --this.length;
  return ret;
};

BufferList.prototype.clear = function () {
  this.head = this.tail = null;
  this.length = 0;
};

BufferList.prototype.join = function (s) {
  if (this.length === 0) return '';
  var p = this.head;
  var ret = '' + p.data;
  while (p = p.next) {
    ret += s + p.data;
  }return ret;
};

BufferList.prototype.concat = function (n) {
  if (this.length === 0) return bufferShim.alloc(0);
  if (this.length === 1) return this.head.data;
  var ret = bufferShim.allocUnsafe(n >>> 0);
  var p = this.head;
  var i = 0;
  while (p) {
    p.data.copy(ret, i);
    i += p.data.length;
    p = p.next;
  }
  return ret;
};
},{"buffer":8,"buffer-shims":42}],42:[function(_dereq_,module,exports){
arguments[4][7][0].apply(exports,arguments)
},{"buffer":8,"dup":7}],43:[function(_dereq_,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":_dereq_("../../../../../../../../../../../../is-buffer/index.js")})
},{"../../../../../../../../../../../../is-buffer/index.js":15}],44:[function(_dereq_,module,exports){
arguments[4][14][0].apply(exports,arguments)
},{"dup":14}],45:[function(_dereq_,module,exports){
arguments[4][9][0].apply(exports,arguments)
},{"dup":9}],46:[function(_dereq_,module,exports){
arguments[4][19][0].apply(exports,arguments)
},{"_process":20,"dup":19}],47:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Buffer = _dereq_('buffer').Buffer;

var isBufferEncoding = Buffer.isEncoding
  || function(encoding) {
       switch (encoding && encoding.toLowerCase()) {
         case 'hex': case 'utf8': case 'utf-8': case 'ascii': case 'binary': case 'base64': case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': case 'raw': return true;
         default: return false;
       }
     }


function assertEncoding(encoding) {
  if (encoding && !isBufferEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters. CESU-8 is handled as part of the UTF-8 encoding.
//
// @TODO Handling all encodings inside a single object makes it very difficult
// to reason about this code, so it should be split up in the future.
// @TODO There should be a utf8-strict encoding that rejects invalid UTF-8 code
// points as used by CESU-8.
var StringDecoder = exports.StringDecoder = function(encoding) {
  this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
  assertEncoding(encoding);
  switch (this.encoding) {
    case 'utf8':
      // CESU-8 represents each of Surrogate Pair by 3-bytes
      this.surrogateSize = 3;
      break;
    case 'ucs2':
    case 'utf16le':
      // UTF-16 represents each of Surrogate Pair by 2-bytes
      this.surrogateSize = 2;
      this.detectIncompleteChar = utf16DetectIncompleteChar;
      break;
    case 'base64':
      // Base-64 stores 3 bytes in 4 chars, and pads the remainder.
      this.surrogateSize = 3;
      this.detectIncompleteChar = base64DetectIncompleteChar;
      break;
    default:
      this.write = passThroughWrite;
      return;
  }

  // Enough space to store all bytes of a single character. UTF-8 needs 4
  // bytes, but CESU-8 may require up to 6 (3 bytes per surrogate).
  this.charBuffer = new Buffer(6);
  // Number of bytes received for the current incomplete multi-byte character.
  this.charReceived = 0;
  // Number of bytes expected for the current incomplete multi-byte character.
  this.charLength = 0;
};


// write decodes the given buffer and returns it as JS string that is
// guaranteed to not contain any partial multi-byte characters. Any partial
// character found at the end of the buffer is buffered up, and will be
// returned when calling write again with the remaining bytes.
//
// Note: Converting a Buffer containing an orphan surrogate to a String
// currently works, but converting a String to a Buffer (via `new Buffer`, or
// Buffer#write) will replace incomplete surrogates with the unicode
// replacement character. See https://codereview.chromium.org/121173009/ .
StringDecoder.prototype.write = function(buffer) {
  var charStr = '';
  // if our last write ended with an incomplete multibyte character
  while (this.charLength) {
    // determine how many remaining bytes this buffer has to offer for this char
    var available = (buffer.length >= this.charLength - this.charReceived) ?
        this.charLength - this.charReceived :
        buffer.length;

    // add the new bytes to the char buffer
    buffer.copy(this.charBuffer, this.charReceived, 0, available);
    this.charReceived += available;

    if (this.charReceived < this.charLength) {
      // still not enough chars in this buffer? wait for more ...
      return '';
    }

    // remove bytes belonging to the current character from the buffer
    buffer = buffer.slice(available, buffer.length);

    // get the character that was split
    charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);

    // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
    var charCode = charStr.charCodeAt(charStr.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      this.charLength += this.surrogateSize;
      charStr = '';
      continue;
    }
    this.charReceived = this.charLength = 0;

    // if there are no more bytes in this buffer, just emit our char
    if (buffer.length === 0) {
      return charStr;
    }
    break;
  }

  // determine and set charLength / charReceived
  this.detectIncompleteChar(buffer);

  var end = buffer.length;
  if (this.charLength) {
    // buffer the incomplete character bytes we got
    buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
    end -= this.charReceived;
  }

  charStr += buffer.toString(this.encoding, 0, end);

  var end = charStr.length - 1;
  var charCode = charStr.charCodeAt(end);
  // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    var size = this.surrogateSize;
    this.charLength += size;
    this.charReceived += size;
    this.charBuffer.copy(this.charBuffer, size, 0, size);
    buffer.copy(this.charBuffer, 0, 0, size);
    return charStr.substring(0, end);
  }

  // or just emit the charStr
  return charStr;
};

// detectIncompleteChar determines if there is an incomplete UTF-8 character at
// the end of the given buffer. If so, it sets this.charLength to the byte
// length that character, and sets this.charReceived to the number of bytes
// that are available for this character.
StringDecoder.prototype.detectIncompleteChar = function(buffer) {
  // determine how many bytes we have to check at the end of this buffer
  var i = (buffer.length >= 3) ? 3 : buffer.length;

  // Figure out if one of the last i bytes of our buffer announces an
  // incomplete char.
  for (; i > 0; i--) {
    var c = buffer[buffer.length - i];

    // See http://en.wikipedia.org/wiki/UTF-8#Description

    // 110XXXXX
    if (i == 1 && c >> 5 == 0x06) {
      this.charLength = 2;
      break;
    }

    // 1110XXXX
    if (i <= 2 && c >> 4 == 0x0E) {
      this.charLength = 3;
      break;
    }

    // 11110XXX
    if (i <= 3 && c >> 3 == 0x1E) {
      this.charLength = 4;
      break;
    }
  }
  this.charReceived = i;
};

StringDecoder.prototype.end = function(buffer) {
  var res = '';
  if (buffer && buffer.length)
    res = this.write(buffer);

  if (this.charReceived) {
    var cr = this.charReceived;
    var buf = this.charBuffer;
    var enc = this.encoding;
    res += buf.slice(0, cr).toString(enc);
  }

  return res;
};

function passThroughWrite(buffer) {
  return buffer.toString(this.encoding);
}

function utf16DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 2;
  this.charLength = this.charReceived ? 2 : 0;
}

function base64DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 3;
  this.charLength = this.charReceived ? 3 : 0;
}

},{"buffer":8}],48:[function(_dereq_,module,exports){
(function (global){

/**
 * Module exports.
 */

module.exports = deprecate;

/**
 * Mark that a method should not be used.
 * Returns a modified function which warns once by default.
 *
 * If `localStorage.noDeprecation = true` is set, then it is a no-op.
 *
 * If `localStorage.throwDeprecation = true` is set, then deprecated functions
 * will throw an Error when invoked.
 *
 * If `localStorage.traceDeprecation = true` is set, then deprecated functions
 * will invoke `console.trace()` instead of `console.error()`.
 *
 * @param {Function} fn - the function to deprecate
 * @param {String} msg - the string to print to the console when `fn` is invoked
 * @returns {Function} a new "deprecated" version of `fn`
 * @api public
 */

function deprecate (fn, msg) {
  if (config('noDeprecation')) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (config('throwDeprecation')) {
        throw new Error(msg);
      } else if (config('traceDeprecation')) {
        console.trace(msg);
      } else {
        console.warn(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
}

/**
 * Checks `localStorage` for boolean values for the given `name`.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */

function config (name) {
  // accessing global.localStorage can trigger a DOMException in sandboxed iframes
  try {
    if (!global.localStorage) return false;
  } catch (_) {
    return false;
  }
  var val = global.localStorage[name];
  if (null == val) return false;
  return String(val).toLowerCase() === 'true';
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],49:[function(_dereq_,module,exports){
(function (process){
var Stream = (function (){
  try {
    return _dereq_('st' + 'ream'); // hack to fix a circular dependency issue when used with browserify
  } catch(_){}
}());
exports = module.exports = _dereq_('./lib/_stream_readable.js');
exports.Stream = Stream || exports;
exports.Readable = exports;
exports.Writable = _dereq_('./lib/_stream_writable.js');
exports.Duplex = _dereq_('./lib/_stream_duplex.js');
exports.Transform = _dereq_('./lib/_stream_transform.js');
exports.PassThrough = _dereq_('./lib/_stream_passthrough.js');

if (!process.browser && process.env.READABLE_STREAM === 'disable' && Stream) {
  module.exports = Stream;
}

}).call(this,_dereq_('_process'))
},{"./lib/_stream_duplex.js":36,"./lib/_stream_passthrough.js":37,"./lib/_stream_readable.js":38,"./lib/_stream_transform.js":39,"./lib/_stream_writable.js":40,"_process":20}],50:[function(_dereq_,module,exports){
'use strict'
var EventEmitter = _dereq_('events').EventEmitter
var util = _dereq_('util')

var trackerId = 0
var TrackerBase = module.exports = function (name) {
  EventEmitter.call(this)
  this.id = ++trackerId
  this.name = name
}
util.inherits(TrackerBase, EventEmitter)

},{"events":11,"util":104}],51:[function(_dereq_,module,exports){
'use strict'
var util = _dereq_('util')
var TrackerBase = _dereq_('./tracker-base.js')
var Tracker = _dereq_('./tracker.js')
var TrackerStream = _dereq_('./tracker-stream.js')

var TrackerGroup = module.exports = function (name) {
  TrackerBase.call(this, name)
  this.parentGroup = null
  this.trackers = []
  this.completion = {}
  this.weight = {}
  this.totalWeight = 0
  this.finished = false
  this.bubbleChange = bubbleChange(this)
}
util.inherits(TrackerGroup, TrackerBase)

function bubbleChange (trackerGroup) {
  return function (name, completed, tracker) {
    trackerGroup.completion[tracker.id] = completed
    if (trackerGroup.finished) return
    trackerGroup.emit('change', name || trackerGroup.name, trackerGroup.completed(), trackerGroup)
  }
}

TrackerGroup.prototype.nameInTree = function () {
  var names = []
  var from = this
  while (from) {
    names.unshift(from.name)
    from = from.parentGroup
  }
  return names.join('/')
}

TrackerGroup.prototype.addUnit = function (unit, weight) {
  if (unit.addUnit) {
    var toTest = this
    while (toTest) {
      if (unit === toTest) {
        throw new Error(
          'Attempted to add tracker group ' +
          unit.name + ' to tree that already includes it ' +
          this.nameInTree(this))
      }
      toTest = toTest.parentGroup
    }
    unit.parentGroup = this
  }
  this.weight[unit.id] = weight || 1
  this.totalWeight += this.weight[unit.id]
  this.trackers.push(unit)
  this.completion[unit.id] = unit.completed()
  unit.on('change', this.bubbleChange)
  if (!this.finished) this.emit('change', unit.name, this.completion[unit.id], unit)
  return unit
}

TrackerGroup.prototype.completed = function () {
  if (this.trackers.length === 0) return 0
  var valPerWeight = 1 / this.totalWeight
  var completed = 0
  for (var ii = 0; ii < this.trackers.length; ii++) {
    var trackerId = this.trackers[ii].id
    completed += valPerWeight * this.weight[trackerId] * this.completion[trackerId]
  }
  return completed
}

TrackerGroup.prototype.newGroup = function (name, weight) {
  return this.addUnit(new TrackerGroup(name), weight)
}

TrackerGroup.prototype.newItem = function (name, todo, weight) {
  return this.addUnit(new Tracker(name, todo), weight)
}

TrackerGroup.prototype.newStream = function (name, todo, weight) {
  return this.addUnit(new TrackerStream(name, todo), weight)
}

TrackerGroup.prototype.finish = function () {
  this.finished = true
  if (!this.trackers.length) this.addUnit(new Tracker(), 1, true)
  for (var ii = 0; ii < this.trackers.length; ii++) {
    var tracker = this.trackers[ii]
    tracker.finish()
    tracker.removeListener('change', this.bubbleChange)
  }
  this.emit('change', this.name, 1, this)
}

var buffer = '                                  '
TrackerGroup.prototype.debug = function (depth) {
  depth = depth || 0
  var indent = depth ? buffer.substr(0, depth) : ''
  var output = indent + (this.name || 'top') + ': ' + this.completed() + '\n'
  this.trackers.forEach(function (tracker) {
    if (tracker instanceof TrackerGroup) {
      output += tracker.debug(depth + 1)
    } else {
      output += indent + ' ' + tracker.name + ': ' + tracker.completed() + '\n'
    }
  })
  return output
}

},{"./tracker-base.js":50,"./tracker-stream.js":52,"./tracker.js":53,"util":104}],52:[function(_dereq_,module,exports){
'use strict'
var util = _dereq_('util')
var stream = _dereq_('readable-stream')
var delegate = _dereq_('delegates')
var Tracker = _dereq_('./tracker.js')

var TrackerStream = module.exports = function (name, size, options) {
  stream.Transform.call(this, options)
  this.tracker = new Tracker(name, size)
  this.name = name
  this.id = this.tracker.id
  this.tracker.on('change', delegateChange(this))
}
util.inherits(TrackerStream, stream.Transform)

function delegateChange (trackerStream) {
  return function (name, completion, tracker) {
    trackerStream.emit('change', name, completion, trackerStream)
  }
}

TrackerStream.prototype._transform = function (data, encoding, cb) {
  this.tracker.completeWork(data.length ? data.length : 1)
  this.push(data)
  cb()
}

TrackerStream.prototype._flush = function (cb) {
  this.tracker.finish()
  cb()
}

delegate(TrackerStream.prototype, 'tracker')
  .method('completed')
  .method('addWork')

},{"./tracker.js":53,"delegates":35,"readable-stream":49,"util":104}],53:[function(_dereq_,module,exports){
'use strict'
var util = _dereq_('util')
var TrackerBase = _dereq_('./tracker-base.js')

var Tracker = module.exports = function (name, todo) {
  TrackerBase.call(this, name)
  this.workDone = 0
  this.workTodo = todo || 0
}
util.inherits(Tracker, TrackerBase)

Tracker.prototype.completed = function () {
  return this.workTodo === 0 ? 0 : this.workDone / this.workTodo
}

Tracker.prototype.addWork = function (work) {
  this.workTodo += work
  this.emit('change', this.name, this.completed(), this)
}

Tracker.prototype.completeWork = function (work) {
  this.workDone += work
  if (this.workDone > this.workTodo) this.workDone = this.workTodo
  this.emit('change', this.name, this.completed(), this)
}

Tracker.prototype.finish = function () {
  this.workTodo = this.workDone = 1
  this.emit('change', this.name, 1, this)
}

},{"./tracker-base.js":50,"util":104}],54:[function(_dereq_,module,exports){
'use strict'

// These tables borrowed from `ansi`

var prefix = '\x1b['

exports.up = function up (num) {
  return prefix + (num || '') + 'A'
}

exports.down = function down (num) {
  return prefix + (num || '') + 'B'
}

exports.forward = function forward (num) {
  return prefix + (num || '') + 'C'
}

exports.back = function back (num) {
  return prefix + (num || '') + 'D'
}

exports.nextLine = function nextLine (num) {
  return prefix + (num || '') + 'E'
}

exports.previousLine = function previousLine (num) {
  return prefix + (num || '') + 'F'
}

exports.horizontalAbsolute = function horizontalAbsolute (num) {
  if (num == null) throw new Error('horizontalAboslute requires a column to position to')
  return prefix + num + 'G'
}

exports.eraseData = function eraseData () {
  return prefix + 'J'
}

exports.eraseLine = function eraseLine () {
  return prefix + 'K'
}

exports.goto = function (x, y) {
  return prefix + y + ';' + x + 'H'
}

exports.gotoSOL = function () {
  return '\r'
}

exports.beep = function () {
  return '\x07'
}

exports.hideCursor = function hideCursor () {
  return prefix + '?25l'
}

exports.showCursor = function showCursor () {
  return prefix + '?25h'
}

var colors = {
  reset: 0,
// styles
  bold: 1,
  italic: 3,
  underline: 4,
  inverse: 7,
// resets
  stopBold: 22,
  stopItalic: 23,
  stopUnderline: 24,
  stopInverse: 27,
// colors
  white: 37,
  black: 30,
  blue: 34,
  cyan: 36,
  green: 32,
  magenta: 35,
  red: 31,
  yellow: 33,
  bgWhite: 47,
  bgBlack: 40,
  bgBlue: 44,
  bgCyan: 46,
  bgGreen: 42,
  bgMagenta: 45,
  bgRed: 41,
  bgYellow: 43,

  grey: 90,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,

  bgGrey: 100,
  bgBrightBlack: 100,
  bgBrightRed: 101,
  bgBrightGreen: 102,
  bgBrightYellow: 103,
  bgBrightBlue: 104,
  bgBrightMagenta: 105,
  bgBrightCyan: 106,
  bgBrightWhite: 107
}

exports.color = function color (colorWith) {
  if (arguments.length !== 1 || !Array.isArray(colorWith)) {
    colorWith = Array.prototype.slice.call(arguments)
  }
  return prefix + colorWith.map(colorNameToCode).join(';') + 'm'
}

function colorNameToCode (color) {
  if (colors[color] != null) return colors[color]
  throw new Error('Unknown color or style name: ' + color)
}

},{}],55:[function(_dereq_,module,exports){
'use strict'
var spin = _dereq_('./spin.js')
var progressBar = _dereq_('./progress-bar.js')

module.exports = {
  activityIndicator: function (values, theme, width) {
    if (values.spun == null) return
    return spin(theme, values.spun)
  },
  progressbar: function (values, theme, width) {
    if (values.completed == null) return
    return progressBar(theme, width, values.completed)
  }
}

},{"./progress-bar.js":74,"./spin.js":78}],56:[function(_dereq_,module,exports){
'use strict'
var util = _dereq_('util')

var User = exports.User = function User (msg) {
  var err = new Error(msg)
  Error.captureStackTrace(err, User)
  err.code = 'EGAUGE'
  return err
}

exports.MissingTemplateValue = function MissingTemplateValue (item, values) {
  var err = new User(util.format('Missing template value "%s"', item.type))
  Error.captureStackTrace(err, MissingTemplateValue)
  err.template = item
  err.values = values
  return err
}

exports.Internal = function Internal (msg) {
  var err = new Error(msg)
  Error.captureStackTrace(err, Internal)
  err.code = 'EGAUGEINTERNAL'
  return err
}

},{"util":104}],57:[function(_dereq_,module,exports){
(function (process){
'use strict'

module.exports = isWin32() || isColorTerm()

function isWin32 () {
  return process.platform === 'win32'
}

function isColorTerm () {
  var termHasColor = /^screen|^xterm|^vt100|color|ansi|cygwin|linux/i
  return !!process.env.COLORTERM || termHasColor.test(process.env.TERM)
}

}).call(this,_dereq_('_process'))
},{"_process":20}],58:[function(_dereq_,module,exports){
'use strict'
var Plumbing = _dereq_('./plumbing.js')
var hasUnicode = _dereq_('has-unicode')
var hasColor = _dereq_('./has-color.js')
var onExit = _dereq_('signal-exit')
var defaultThemes = _dereq_('./themes')
var setInterval = _dereq_('./set-interval.js')
var process = _dereq_('./process.js')
var setImmediate = _dereq_('./set-immediate')

module.exports = Gauge

function callWith (obj, method) {
  return function () {
    return method.call(obj)
  }
}

function Gauge (arg1, arg2) {
  var options, writeTo
  if (arg1 && arg1.write) {
    writeTo = arg1
    options = arg2 || {}
  } else if (arg2 && arg2.write) {
    writeTo = arg2
    options = arg1 || {}
  } else {
    writeTo = process.stderr
    options = arg1 || arg2 || {}
  }

  this._status = {
    spun: 0,
    section: '',
    subsection: ''
  }
  this._paused = false // are we paused for back pressure?
  this._disabled = true // are all progress bar updates disabled?
  this._showing = false // do we WANT the progress bar on screen
  this._onScreen = false // IS the progress bar on screen
  this._needsRedraw = false // should we print something at next tick?
  this._hideCursor = options.hideCursor == null ? true : options.hideCursor
  this._fixedFramerate = options.fixedFramerate == null
    ? !(/^v0\.8\./.test(process.version))
    : options.fixedFramerate
  this._lastUpdateAt = null
  this._updateInterval = options.updateInterval == null ? 50 : options.updateInterval

  this._themes = options.themes || defaultThemes
  this._theme = options.theme
  var theme = this._computeTheme(options.theme)
  var template = options.template || [
    {type: 'progressbar', length: 20},
    {type: 'activityIndicator', kerning: 1, length: 1},
    {type: 'section', kerning: 1, default: ''},
    {type: 'subsection', kerning: 1, default: ''}
  ]
  this.setWriteTo(writeTo, options.tty)
  var PlumbingClass = options.Plumbing || Plumbing
  this._gauge = new PlumbingClass(theme, template, this.getWidth())

  this._$$doRedraw = callWith(this, this._doRedraw)
  this._$$handleSizeChange = callWith(this, this._handleSizeChange)

  if (options.cleanupOnExit == null || options.cleanupOnExit) {
    onExit(callWith(this, this.disable))
  }

  if (options.enabled || (options.enabled == null && this._tty && this._tty.isTTY)) {
    this.enable()
  } else {
    this.disable()
  }
}
Gauge.prototype = {}

Gauge.prototype.setTemplate = function (template) {
  this._gauge.setTemplate(template)
  if (this._showing) this._requestRedraw()
}

Gauge.prototype._computeTheme = function (theme) {
  if (!theme) theme = {}
  if (theme && (Object.keys(theme).length === 0 || theme.hasUnicode != null || theme.hasColor != null)) {
    var useUnicode = theme.hasUnicode == null ? hasUnicode() : theme.hasUnicode
    var useColor = theme.hasColor == null ? hasColor : theme.hasColor
    theme = this._themes.getDefault({hasUnicode: useUnicode, hasColor: useColor, platform: theme.platform})
  } else if (typeof theme === 'string') {
    theme = this._themes.getTheme(theme)
  }
  return theme
}

Gauge.prototype.setThemeset = function (themes) {
  this._themes = themes
  this.setTheme(this._theme)
}

Gauge.prototype.setTheme = function (theme) {
  this._gauge.setTheme(this._computeTheme(theme))
  if (this._showing) this._requestRedraw()
  this._theme = theme
}

Gauge.prototype._requestRedraw = function () {
  this._needsRedraw = true
  if (!this._fixedFramerate) this._doRedraw()
}

Gauge.prototype.getWidth = function () {
  return ((this._tty && this._tty.columns) || 80) - 1
}

Gauge.prototype.setWriteTo = function (writeTo, tty) {
  var enabled = !this._disabled
  if (enabled) this.disable()
  this._writeTo = writeTo
  this._tty = tty ||
    (writeTo === process.stderr && process.stdout.isTTY && process.stdout) ||
    (writeTo.isTTY && writeTo) ||
    this._tty
  if (this._gauge) this._gauge.setWidth(this.getWidth())
  if (enabled) this.enable()
}

Gauge.prototype.enable = function () {
  if (!this._disabled) return
  this._disabled = false
  if (this._tty) this._enableEvents()
  if (this._showing) this.show()
}

Gauge.prototype.disable = function () {
  if (this._disabled) return
  if (this._showing) {
    this._lastUpdateAt = null
    this._showing = false
    this._doRedraw()
    this._showing = true
  }
  this._disabled = true
  if (this._tty) this._disableEvents()
}

Gauge.prototype._enableEvents = function () {
  this._tty.on('resize', this._$$handleSizeChange)
  if (this._fixedFramerate) {
    this.redrawTracker = setInterval(this._$$doRedraw, this._updateInterval)
    if (this.redrawTracker.unref) this.redrawTracker.unref()
  }
}

Gauge.prototype._disableEvents = function () {
  this._tty.removeListener('resize', this._$$handleSizeChange)
  if (this._fixedFramerate) clearInterval(this.redrawTracker)
}

Gauge.prototype.hide = function (cb) {
  if (this._disabled) return cb && process.nextTick(cb)
  if (!this._showing) return cb && process.nextTick(cb)
  this._showing = false
  this._doRedraw()
  cb && setImmediate(cb)
}

Gauge.prototype.show = function (section, completed) {
  if (this._disabled) return
  this._showing = true
  if (typeof section === 'string') {
    this._status.section = section
  } else if (typeof section === 'object') {
    var sectionKeys = Object.keys(section)
    for (var ii = 0; ii < sectionKeys.length; ++ii) {
      var key = sectionKeys[ii]
      this._status[key] = section[key]
    }
  }
  if (completed != null) this._status.completed = completed
  this._requestRedraw()
}

Gauge.prototype.pulse = function (subsection) {
  if (this._disabled) return
  if (!this._showing) return
  this._status.subsection = subsection || ''
  this._status.spun ++
  this._requestRedraw()
}

Gauge.prototype._handleSizeChange = function () {
  this._gauge.setWidth(this._tty.columns - 1)
  this._requestRedraw()
}

Gauge.prototype._doRedraw = function () {
  if (this._disabled || this._paused) return
  if (!this._fixedFramerate) {
    var now = Date.now()
    if (this._lastUpdateAt && now - this._lastUpdateAt < this._updateInterval) return
    this._lastUpdateAt = now
  }
  if (!this._showing && this._onScreen) {
    this._onScreen = false
    var result = this._gauge.hide()
    if (this._hideCursor) {
      result += this._gauge.showCursor()
    }
    return this._writeTo.write(result)
  }
  if (!this._showing && !this._onScreen) return
  if (this._showing && !this._onScreen) {
    this._onScreen = true
    this._needsRedraw = true
    if (this._hideCursor) {
      this._writeTo.write(this._gauge.hideCursor())
    }
  }
  if (!this._needsRedraw) return
  if (!this._writeTo.write(this._gauge.show(this._status))) {
    this._paused = true
    this._writeTo.on('drain', callWith(this, function () {
      this._paused = false
      this._doRedraw()
    }))
  }
}

},{"./has-color.js":57,"./plumbing.js":72,"./process.js":73,"./set-immediate":76,"./set-interval.js":77,"./themes":81,"has-unicode":60,"signal-exit":62}],59:[function(_dereq_,module,exports){
'use strict'

function isArguments (thingy) {
  return typeof thingy === 'object' && thingy.hasOwnProperty('callee')
}

var types = {
  '*': ['any', function () { return true }],
  A: ['array', function (thingy) { return Array.isArray(thingy) || isArguments(thingy) }],
  S: ['string', function (thingy) { return typeof thingy === 'string' }],
  N: ['number', function (thingy) { return typeof thingy === 'number' }],
  F: ['function', function (thingy) { return typeof thingy === 'function' }],
  O: ['object', function (thingy) { return typeof thingy === 'object' && !types.A[1](thingy) && !types.E[1](thingy) }],
  B: ['boolean', function (thingy) { return typeof thingy === 'boolean' }],
  E: ['error', function (thingy) { return thingy instanceof Error }]
}

var validate = module.exports = function (schema, args) {
  if (!schema) throw missingRequiredArg(0, 'schema')
  if (!args) throw missingRequiredArg(1, 'args')
  if (!types.S[1](schema)) throw invalidType(0, 'string', schema)
  if (!types.A[1](args)) throw invalidType(1, 'array', args)
  for (var ii = 0; ii < schema.length; ++ii) {
    var type = schema[ii]
    if (!types[type]) throw unknownType(ii, type)
    var typeLabel = types[type][0]
    var typeCheck = types[type][1]
    if (type === 'E' && args[ii] == null) continue
    if (args[ii] == null) throw missingRequiredArg(ii)
    if (!typeCheck(args[ii])) throw invalidType(ii, typeLabel, args[ii])
    if (type === 'E') return
  }
  if (schema.length < args.length) throw tooManyArgs(schema.length, args.length)
}

function missingRequiredArg (num) {
  return newException('EMISSINGARG', 'Missing required argument #' + (num + 1))
}

function unknownType (num, type) {
  return newException('EUNKNOWNTYPE', 'Unknown type ' + type + ' in argument #' + (num + 1))
}

function invalidType (num, expectedType, value) {
  var valueType
  Object.keys(types).forEach(function (typeCode) {
    if (types[typeCode][1](value)) valueType = types[typeCode][0]
  })
  return newException('EINVALIDTYPE', 'Argument #' + (num + 1) + ': Expected ' +
    expectedType + ' but got ' + valueType)
}

function tooManyArgs (expected, got) {
  return newException('ETOOMANYARGS', 'Too many arguments, expected ' + expected + ' and got ' + got)
}

function newException (code, msg) {
  var e = new Error(msg)
  e.code = code
  Error.captureStackTrace(e, validate)
  return e
}

},{}],60:[function(_dereq_,module,exports){
(function (process){
"use strict"
var os = _dereq_("os")

var hasUnicode = module.exports = function () {
  // Recent Win32 platforms (>XP) CAN support unicode in the console but
  // don't have to, and in non-english locales often use traditional local
  // code pages. There's no way, short of windows system calls or execing
  // the chcp command line program to figure this out. As such, we default
  // this to false and encourage your users to override it via config if
  // appropriate.
  if (os.type() == "Windows_NT") { return false }

  var isUTF8 = /UTF-?8$/i
  var ctype = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG
  return isUTF8.test(ctype)
}

}).call(this,_dereq_('_process'))
},{"_process":20,"os":17}],61:[function(_dereq_,module,exports){
'use strict';
/* eslint-disable no-unused-vars */
var hasOwnProperty = Object.prototype.hasOwnProperty;
var propIsEnumerable = Object.prototype.propertyIsEnumerable;

function toObject(val) {
	if (val === null || val === undefined) {
		throw new TypeError('Object.assign cannot be called with null or undefined');
	}

	return Object(val);
}

function shouldUseNative() {
	try {
		if (!Object.assign) {
			return false;
		}

		// Detect buggy property enumeration order in older V8 versions.

		// https://bugs.chromium.org/p/v8/issues/detail?id=4118
		var test1 = new String('abc');  // eslint-disable-line
		test1[5] = 'de';
		if (Object.getOwnPropertyNames(test1)[0] === '5') {
			return false;
		}

		// https://bugs.chromium.org/p/v8/issues/detail?id=3056
		var test2 = {};
		for (var i = 0; i < 10; i++) {
			test2['_' + String.fromCharCode(i)] = i;
		}
		var order2 = Object.getOwnPropertyNames(test2).map(function (n) {
			return test2[n];
		});
		if (order2.join('') !== '0123456789') {
			return false;
		}

		// https://bugs.chromium.org/p/v8/issues/detail?id=3056
		var test3 = {};
		'abcdefghijklmnopqrst'.split('').forEach(function (letter) {
			test3[letter] = letter;
		});
		if (Object.keys(Object.assign({}, test3)).join('') !==
				'abcdefghijklmnopqrst') {
			return false;
		}

		return true;
	} catch (e) {
		// We don't expect any of the above to throw, but better to be safe.
		return false;
	}
}

module.exports = shouldUseNative() ? Object.assign : function (target, source) {
	var from;
	var to = toObject(target);
	var symbols;

	for (var s = 1; s < arguments.length; s++) {
		from = Object(arguments[s]);

		for (var key in from) {
			if (hasOwnProperty.call(from, key)) {
				to[key] = from[key];
			}
		}

		if (Object.getOwnPropertySymbols) {
			symbols = Object.getOwnPropertySymbols(from);
			for (var i = 0; i < symbols.length; i++) {
				if (propIsEnumerable.call(from, symbols[i])) {
					to[symbols[i]] = from[symbols[i]];
				}
			}
		}
	}

	return to;
};

},{}],62:[function(_dereq_,module,exports){
(function (process){
// Note: since nyc uses this module to output coverage, any lines
// that are in the direct sync flow of nyc's outputCoverage are
// ignored, since we can never get coverage for them.
var assert = _dereq_('assert')
var signals = _dereq_('./signals.js')

var EE = _dereq_('events')
/* istanbul ignore if */
if (typeof EE !== 'function') {
  EE = EE.EventEmitter
}

var emitter
if (process.__signal_exit_emitter__) {
  emitter = process.__signal_exit_emitter__
} else {
  emitter = process.__signal_exit_emitter__ = new EE()
  emitter.count = 0
  emitter.emitted = {}
}

module.exports = function (cb, opts) {
  assert.equal(typeof cb, 'function', 'a callback must be provided for exit handler')

  if (loaded === false) {
    load()
  }

  var ev = 'exit'
  if (opts && opts.alwaysLast) {
    ev = 'afterexit'
  }

  var remove = function () {
    emitter.removeListener(ev, cb)
    if (emitter.listeners('exit').length === 0 &&
        emitter.listeners('afterexit').length === 0) {
      unload()
    }
  }
  emitter.on(ev, cb)

  return remove
}

module.exports.unload = unload
function unload () {
  if (!loaded) {
    return
  }
  loaded = false

  signals.forEach(function (sig) {
    try {
      process.removeListener(sig, sigListeners[sig])
    } catch (er) {}
  })
  process.emit = originalProcessEmit
  process.reallyExit = originalProcessReallyExit
  emitter.count -= 1
}

function emit (event, code, signal) {
  if (emitter.emitted[event]) {
    return
  }
  emitter.emitted[event] = true
  emitter.emit(event, code, signal)
}

// { <signal>: <listener fn>, ... }
var sigListeners = {}
signals.forEach(function (sig) {
  sigListeners[sig] = function listener () {
    // If there are no other listeners, an exit is coming!
    // Simplest way: remove us and then re-send the signal.
    // We know that this will kill the process, so we can
    // safely emit now.
    var listeners = process.listeners(sig)
    if (listeners.length === emitter.count) {
      unload()
      emit('exit', null, sig)
      /* istanbul ignore next */
      emit('afterexit', null, sig)
      /* istanbul ignore next */
      process.kill(process.pid, sig)
    }
  }
})

module.exports.signals = function () {
  return signals
}

module.exports.load = load

var loaded = false

function load () {
  if (loaded) {
    return
  }
  loaded = true

  // This is the number of onSignalExit's that are in play.
  // It's important so that we can count the correct number of
  // listeners on signals, and don't wait for the other one to
  // handle it instead of us.
  emitter.count += 1

  signals = signals.filter(function (sig) {
    try {
      process.on(sig, sigListeners[sig])
      return true
    } catch (er) {
      return false
    }
  })

  process.emit = processEmit
  process.reallyExit = processReallyExit
}

var originalProcessReallyExit = process.reallyExit
function processReallyExit (code) {
  process.exitCode = code || 0
  emit('exit', process.exitCode, null)
  /* istanbul ignore next */
  emit('afterexit', process.exitCode, null)
  /* istanbul ignore next */
  originalProcessReallyExit.call(process, process.exitCode)
}

var originalProcessEmit = process.emit
function processEmit (ev, arg) {
  if (ev === 'exit') {
    if (arg !== undefined) {
      process.exitCode = arg
    }
    var ret = originalProcessEmit.apply(this, arguments)
    emit('exit', process.exitCode, null)
    /* istanbul ignore next */
    emit('afterexit', process.exitCode, null)
    return ret
  } else {
    return originalProcessEmit.apply(this, arguments)
  }
}

}).call(this,_dereq_('_process'))
},{"./signals.js":63,"_process":20,"assert":3,"events":11}],63:[function(_dereq_,module,exports){
(function (process){
// This is not the set of all possible signals.
//
// It IS, however, the set of all signals that trigger
// an exit on either Linux or BSD systems.  Linux is a
// superset of the signal names supported on BSD, and
// the unknown signals just fail to register, so we can
// catch that easily enough.
//
// Don't bother with SIGKILL.  It's uncatchable, which
// means that we can't fire any callbacks anyway.
//
// If a user does happen to register a handler on a non-
// fatal signal like SIGWINCH or something, and then
// exit, it'll end up firing `process.emit('exit')`, so
// the handler will be fired anyway.
//
// SIGBUS, SIGFPE, SIGSEGV and SIGILL, when not raised
// artificially, inherently leave the process in a
// state from which it is not safe to try and enter JS
// listeners.
module.exports = [
  'SIGABRT',
  'SIGALRM',
  'SIGHUP',
  'SIGINT',
  'SIGTERM'
]

if (process.platform !== 'win32') {
  module.exports.push(
    'SIGVTALRM',
    'SIGXCPU',
    'SIGXFSZ',
    'SIGUSR2',
    'SIGTRAP',
    'SIGSYS',
    'SIGQUIT',
    'SIGIOT'
    // should detect profiler and enable/disable accordingly.
    // see #21
    // 'SIGPROF'
  )
}

if (process.platform === 'linux') {
  module.exports.push(
    'SIGIO',
    'SIGPOLL',
    'SIGPWR',
    'SIGSTKFLT',
    'SIGUNUSED'
  )
}

}).call(this,_dereq_('_process'))
},{"_process":20}],64:[function(_dereq_,module,exports){
'use strict';
var stripAnsi = _dereq_('strip-ansi');
var codePointAt = _dereq_('code-point-at');
var isFullwidthCodePoint = _dereq_('is-fullwidth-code-point');

// https://github.com/nodejs/io.js/blob/cff7300a578be1b10001f2d967aaedc88aee6402/lib/readline.js#L1345
module.exports = function (str) {
	if (typeof str !== 'string' || str.length === 0) {
		return 0;
	}

	var width = 0;

	str = stripAnsi(str);

	for (var i = 0; i < str.length; i++) {
		var code = codePointAt(str, i);

		// ignore control characters
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
			continue;
		}

		// surrogates
		if (code >= 0x10000) {
			i++;
		}

		if (isFullwidthCodePoint(code)) {
			width += 2;
		} else {
			width++;
		}
	}

	return width;
};

},{"code-point-at":65,"is-fullwidth-code-point":67,"strip-ansi":69}],65:[function(_dereq_,module,exports){
'use strict';
var numberIsNan = _dereq_('number-is-nan');

module.exports = function (str, pos) {
	if (str === null || str === undefined) {
		throw TypeError();
	}

	str = String(str);

	var size = str.length;
	var i = pos ? Number(pos) : 0;

	if (numberIsNan(i)) {
		i = 0;
	}

	if (i < 0 || i >= size) {
		return undefined;
	}

	var first = str.charCodeAt(i);

	if (first >= 0xD800 && first <= 0xDBFF && size > i + 1) {
		var second = str.charCodeAt(i + 1);

		if (second >= 0xDC00 && second <= 0xDFFF) {
			return (first - 0xD800) * 0x400 + second - 0xDC00 + 0x10000;
		}
	}

	return first;
};

},{"number-is-nan":66}],66:[function(_dereq_,module,exports){
'use strict';
module.exports = Number.isNaN || function (x) {
	return x !== x;
};

},{}],67:[function(_dereq_,module,exports){
'use strict';
var numberIsNan = _dereq_('number-is-nan');

module.exports = function (x) {
	if (numberIsNan(x)) {
		return false;
	}

	// https://github.com/nodejs/io.js/blob/cff7300a578be1b10001f2d967aaedc88aee6402/lib/readline.js#L1369

	// code points are derived from:
	// http://www.unix.org/Public/UNIDATA/EastAsianWidth.txt
	if (x >= 0x1100 && (
		x <= 0x115f ||  // Hangul Jamo
		0x2329 === x || // LEFT-POINTING ANGLE BRACKET
		0x232a === x || // RIGHT-POINTING ANGLE BRACKET
		// CJK Radicals Supplement .. Enclosed CJK Letters and Months
		(0x2e80 <= x && x <= 0x3247 && x !== 0x303f) ||
		// Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
		0x3250 <= x && x <= 0x4dbf ||
		// CJK Unified Ideographs .. Yi Radicals
		0x4e00 <= x && x <= 0xa4c6 ||
		// Hangul Jamo Extended-A
		0xa960 <= x && x <= 0xa97c ||
		// Hangul Syllables
		0xac00 <= x && x <= 0xd7a3 ||
		// CJK Compatibility Ideographs
		0xf900 <= x && x <= 0xfaff ||
		// Vertical Forms
		0xfe10 <= x && x <= 0xfe19 ||
		// CJK Compatibility Forms .. Small Form Variants
		0xfe30 <= x && x <= 0xfe6b ||
		// Halfwidth and Fullwidth Forms
		0xff01 <= x && x <= 0xff60 ||
		0xffe0 <= x && x <= 0xffe6 ||
		// Kana Supplement
		0x1b000 <= x && x <= 0x1b001 ||
		// Enclosed Ideographic Supplement
		0x1f200 <= x && x <= 0x1f251 ||
		// CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
		0x20000 <= x && x <= 0x3fffd)) {
		return true;
	}

	return false;
}

},{"number-is-nan":68}],68:[function(_dereq_,module,exports){
arguments[4][66][0].apply(exports,arguments)
},{"dup":66}],69:[function(_dereq_,module,exports){
'use strict';
var ansiRegex = _dereq_('ansi-regex')();

module.exports = function (str) {
	return typeof str === 'string' ? str.replace(ansiRegex, '') : str;
};

},{"ansi-regex":70}],70:[function(_dereq_,module,exports){
'use strict';
module.exports = function () {
	return /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
};

},{}],71:[function(_dereq_,module,exports){
'use strict'
var stringWidth = _dereq_('string-width')

exports.center = alignCenter
exports.left = alignLeft
exports.right = alignRight

// lodash's way of generating pad characters.

function createPadding (width) {
  var result = ''
  var string = ' '
  var n = width
  do {
    if (n % 2) {
      result += string;
    }
    n = Math.floor(n / 2);
    string += string;
  } while (n);

  return result;
}

function alignLeft (str, width) {
  var trimmed = str.trimRight()
  if (trimmed.length === 0 && str.length >= width) return str
  var padding = ''
  var strWidth = stringWidth(trimmed)

  if (strWidth < width) {
    padding = createPadding(width - strWidth)
  }

  return trimmed + padding
}

function alignRight (str, width) {
  var trimmed = str.trimLeft()
  if (trimmed.length === 0 && str.length >= width) return str
  var padding = ''
  var strWidth = stringWidth(trimmed)

  if (strWidth < width) {
    padding = createPadding(width - strWidth)
  }

  return padding + trimmed
}

function alignCenter (str, width) {
  var trimmed = str.trim()
  if (trimmed.length === 0 && str.length >= width) return str
  var padLeft = ''
  var padRight = ''
  var strWidth = stringWidth(trimmed)

  if (strWidth < width) {
    var padLeftBy = parseInt((width - strWidth) / 2, 10) 
    padLeft = createPadding(padLeftBy)
    padRight = createPadding(width - (strWidth + padLeftBy))
  }

  return padLeft + trimmed + padRight
}

},{"string-width":64}],72:[function(_dereq_,module,exports){
'use strict'
var consoleControl = _dereq_('console-control-strings')
var renderTemplate = _dereq_('./render-template.js')
var validate = _dereq_('aproba')

var Plumbing = module.exports = function (theme, template, width) {
  if (!width) width = 80
  validate('OAN', [theme, template, width])
  this.showing = false
  this.theme = theme
  this.width = width
  this.template = template
}
Plumbing.prototype = {}

Plumbing.prototype.setTheme = function (theme) {
  validate('O', [theme])
  this.theme = theme
}

Plumbing.prototype.setTemplate = function (template) {
  validate('A', [template])
  this.template = template
}

Plumbing.prototype.setWidth = function (width) {
  validate('N', [width])
  this.width = width
}

Plumbing.prototype.hide = function () {
  return consoleControl.gotoSOL() + consoleControl.eraseLine()
}

Plumbing.prototype.hideCursor = consoleControl.hideCursor

Plumbing.prototype.showCursor = consoleControl.showCursor

Plumbing.prototype.show = function (status) {
  var values = Object.create(this.theme)
  for (var key in status) {
    values[key] = status[key]
  }

  return renderTemplate(this.width, this.template, values).trim() +
         consoleControl.eraseLine() + consoleControl.gotoSOL()
}

},{"./render-template.js":75,"aproba":59,"console-control-strings":54}],73:[function(_dereq_,module,exports){
(function (process){
'use strict'
// this exists so we can replace it during testing
module.exports = process

}).call(this,_dereq_('_process'))
},{"_process":20}],74:[function(_dereq_,module,exports){
'use strict'
var validate = _dereq_('aproba')
var renderTemplate = _dereq_('./render-template.js')
var wideTruncate = _dereq_('./wide-truncate')
var stringWidth = _dereq_('string-width')

module.exports = function (theme, width, completed) {
  validate('ONN', [theme, width, completed])
  if (completed < 0) completed = 0
  if (completed > 1) completed = 1
  if (width <= 0) return ''
  var sofar = Math.round(width * completed)
  var rest = width - sofar
  var template = [
    {type: 'complete', value: repeat(theme.complete, sofar), length: sofar},
    {type: 'remaining', value: repeat(theme.remaining, rest), length: rest}
  ]
  return renderTemplate(width, template, theme)
}

// lodash's way of repeating
function repeat (string, width) {
  var result = ''
  var n = width
  do {
    if (n % 2) {
      result += string
    }
    n = Math.floor(n / 2)
    /*eslint no-self-assign: 0*/
    string += string
  } while (n && stringWidth(result) < width)

  return wideTruncate(result, width)
}

},{"./render-template.js":75,"./wide-truncate":82,"aproba":59,"string-width":64}],75:[function(_dereq_,module,exports){
'use strict'
var align = _dereq_('wide-align')
var validate = _dereq_('aproba')
var objectAssign = _dereq_('object-assign')
var wideTruncate = _dereq_('./wide-truncate')
var error = _dereq_('./error')
var TemplateItem = _dereq_('./template-item')

function renderValueWithValues (values) {
  return function (item) {
    return renderValue(item, values)
  }
}

var renderTemplate = module.exports = function (width, template, values) {
  var items = prepareItems(width, template, values)
  var rendered = items.map(renderValueWithValues(values)).join('')
  return align.left(wideTruncate(rendered, width), width)
}

function preType (item) {
  var cappedTypeName = item.type[0].toUpperCase() + item.type.slice(1)
  return 'pre' + cappedTypeName
}

function postType (item) {
  var cappedTypeName = item.type[0].toUpperCase() + item.type.slice(1)
  return 'post' + cappedTypeName
}

function hasPreOrPost (item, values) {
  if (!item.type) return
  return values[preType(item)] || values[postType(item)]
}

function generatePreAndPost (baseItem, parentValues) {
  var item = objectAssign({}, baseItem)
  var values = Object.create(parentValues)
  var template = []
  var pre = preType(item)
  var post = postType(item)
  if (values[pre]) {
    template.push({value: values[pre]})
    values[pre] = null
  }
  item.minLength = null
  item.length = null
  item.maxLength = null
  template.push(item)
  values[item.type] = values[item.type]
  if (values[post]) {
    template.push({value: values[post]})
    values[post] = null
  }
  return function ($1, $2, length) {
    return renderTemplate(length, template, values)
  }
}

function prepareItems (width, template, values) {
  function cloneAndObjectify (item, index, arr) {
    var cloned = new TemplateItem(item, width)
    var type = cloned.type
    if (cloned.value == null) {
      if (!(type in values)) {
        if (cloned.default == null) {
          throw new error.MissingTemplateValue(cloned, values)
        } else {
          cloned.value = cloned.default
        }
      } else {
        cloned.value = values[type]
      }
    }
    if (cloned.value == null || cloned.value === '') return null
    cloned.index = index
    cloned.first = index === 0
    cloned.last = index === arr.length - 1
    if (hasPreOrPost(cloned, values)) cloned.value = generatePreAndPost(cloned, values)
    return cloned
  }

  var output = template.map(cloneAndObjectify).filter(function (item) { return item != null })

  var outputLength = 0
  var remainingSpace = width
  var variableCount = output.length

  function consumeSpace (length) {
    if (length > remainingSpace) length = remainingSpace
    outputLength += length
    remainingSpace -= length
  }

  function finishSizing (item, length) {
    if (item.finished) throw new error.Internal('Tried to finish template item that was already finished')
    if (length === Infinity) throw new error.Internal('Length of template item cannot be infinity')
    if (length != null) item.length = length
    item.minLength = null
    item.maxLength = null
    --variableCount
    item.finished = true
    if (item.length == null) item.length = item.getBaseLength()
    if (item.length == null) throw new error.Internal('Finished template items must have a length')
    consumeSpace(item.getLength())
  }

  output.forEach(function (item) {
    if (!item.kerning) return
    var prevPadRight = item.first ? 0 : output[item.index - 1].padRight
    if (!item.first && prevPadRight < item.kerning) item.padLeft = item.kerning - prevPadRight
    if (!item.last) item.padRight = item.kerning
  })

  // Finish any that have a fixed (literal or intuited) length
  output.forEach(function (item) {
    if (item.getBaseLength() == null) return
    finishSizing(item)
  })

  var resized = 0
  var resizing
  var hunkSize
  do {
    resizing = false
    hunkSize = Math.round(remainingSpace / variableCount)
    output.forEach(function (item) {
      if (item.finished) return
      if (!item.maxLength) return
      if (item.getMaxLength() < hunkSize) {
        finishSizing(item, item.maxLength)
        resizing = true
      }
    })
  } while (resizing && resized++ < output.length)
  if (resizing) throw new error.Internal('Resize loop iterated too many times while determining maxLength')

  resized = 0
  do {
    resizing = false
    hunkSize = Math.round(remainingSpace / variableCount)
    output.forEach(function (item) {
      if (item.finished) return
      if (!item.minLength) return
      if (item.getMinLength() >= hunkSize) {
        finishSizing(item, item.minLength)
        resizing = true
      }
    })
  } while (resizing && resized++ < output.length)
  if (resizing) throw new error.Internal('Resize loop iterated too many times while determining minLength')

  hunkSize = Math.round(remainingSpace / variableCount)
  output.forEach(function (item) {
    if (item.finished) return
    finishSizing(item, hunkSize)
  })

  return output
}

function renderFunction (item, values, length) {
  validate('OON', arguments)
  if (item.type) {
    return item.value(values, values[item.type + 'Theme'] || {}, length)
  } else {
    return item.value(values, {}, length)
  }
}

function renderValue (item, values) {
  var length = item.getBaseLength()
  var value = typeof item.value === 'function' ? renderFunction(item, values, length) : item.value
  if (value == null || value === '') return ''
  var alignWith = align[item.align] || align.left
  var leftPadding = item.padLeft ? align.left('', item.padLeft) : ''
  var rightPadding = item.padRight ? align.right('', item.padRight) : ''
  var truncated = wideTruncate(String(value), length)
  var aligned = alignWith(truncated, length)
  return leftPadding + aligned + rightPadding
}

},{"./error":56,"./template-item":79,"./wide-truncate":82,"aproba":59,"object-assign":61,"wide-align":71}],76:[function(_dereq_,module,exports){
'use strict'
var process = _dereq_('./process')
try {
  module.exports = setImmediate
} catch (ex) {
  module.exports = process.nextTick
}

},{"./process":73}],77:[function(_dereq_,module,exports){
'use strict'
// this exists so we can replace it during testing
module.exports = setInterval

},{}],78:[function(_dereq_,module,exports){
'use strict'

module.exports = function spin (spinstr, spun) {
  return spinstr[spun % spinstr.length]
}

},{}],79:[function(_dereq_,module,exports){
'use strict'
var stringWidth = _dereq_('string-width')

module.exports = TemplateItem

function isPercent (num) {
  if (typeof num !== 'string') return false
  return num.slice(-1) === '%'
}

function percent (num) {
  return Number(num.slice(0, -1)) / 100
}

function TemplateItem (values, outputLength) {
  this.overallOutputLength = outputLength
  this.finished = false
  this.type = null
  this.value = null
  this.length = null
  this.maxLength = null
  this.minLength = null
  this.kerning = null
  this.align = 'left'
  this.padLeft = 0
  this.padRight = 0
  this.index = null
  this.first = null
  this.last = null
  if (typeof values === 'string') {
    this.value = values
  } else {
    for (var prop in values) this[prop] = values[prop]
  }
  // Realize percents
  if (isPercent(this.length)) {
    this.length = Math.round(this.overallOutputLength * percent(this.length))
  }
  if (isPercent(this.minLength)) {
    this.minLength = Math.round(this.overallOutputLength * percent(this.minLength))
  }
  if (isPercent(this.maxLength)) {
    this.maxLength = Math.round(this.overallOutputLength * percent(this.maxLength))
  }
  return this
}

TemplateItem.prototype = {}

TemplateItem.prototype.getBaseLength = function () {
  var length = this.length
  if (length == null && typeof this.value === 'string' && this.maxLength == null && this.minLength == null) {
    length = stringWidth(this.value)
  }
  return length
}

TemplateItem.prototype.getLength = function () {
  var length = this.getBaseLength()
  if (length == null) return null
  return length + this.padLeft + this.padRight
}

TemplateItem.prototype.getMaxLength = function () {
  if (this.maxLength == null) return null
  return this.maxLength + this.padLeft + this.padRight
}

TemplateItem.prototype.getMinLength = function () {
  if (this.minLength == null) return null
  return this.minLength + this.padLeft + this.padRight
}


},{"string-width":64}],80:[function(_dereq_,module,exports){
(function (process){
'use strict'
var objectAssign = _dereq_('object-assign')

module.exports = function () {
  return ThemeSetProto.newThemeSet()
}

var ThemeSetProto = {}

ThemeSetProto.baseTheme = _dereq_('./base-theme.js')

ThemeSetProto.newTheme = function (parent, theme) {
  if (!theme) {
    theme = parent
    parent = this.baseTheme
  }
  return objectAssign({}, parent, theme)
}

ThemeSetProto.getThemeNames = function () {
  return Object.keys(this.themes)
}

ThemeSetProto.addTheme = function (name, parent, theme) {
  this.themes[name] = this.newTheme(parent, theme)
}

ThemeSetProto.addToAllThemes = function (theme) {
  var themes = this.themes
  Object.keys(themes).forEach(function (name) {
    objectAssign(themes[name], theme)
  })
  objectAssign(this.baseTheme, theme)
}

ThemeSetProto.getTheme = function (name) {
  if (!this.themes[name]) throw this.newMissingThemeError(name)
  return this.themes[name]
}

ThemeSetProto.setDefault = function (opts, name) {
  if (name == null) {
    name = opts
    opts = {}
  }
  var platform = opts.platform == null ? 'fallback' : opts.platform
  var hasUnicode = !!opts.hasUnicode
  var hasColor = !!opts.hasColor
  if (!this.defaults[platform]) this.defaults[platform] = {true: {}, false: {}}
  this.defaults[platform][hasUnicode][hasColor] = name
}

ThemeSetProto.getDefault = function (opts) {
  if (!opts) opts = {}
  var platformName = opts.platform || process.platform
  var platform = this.defaults[platformName] || this.defaults.fallback
  var hasUnicode = !!opts.hasUnicode
  var hasColor = !!opts.hasColor
  if (!platform) throw this.newMissingDefaultThemeError(platformName, hasUnicode, hasColor)
  if (!platform[hasUnicode][hasColor]) {
    if (hasUnicode && hasColor && platform[!hasUnicode][hasColor]) {
      hasUnicode = false
    } else if (hasUnicode && hasColor && platform[hasUnicode][!hasColor]) {
      hasColor = false
    } else if (hasUnicode && hasColor && platform[!hasUnicode][!hasColor]) {
      hasUnicode = false
      hasColor = false
    } else if (hasUnicode && !hasColor && platform[!hasUnicode][hasColor]) {
      hasUnicode = false
    } else if (!hasUnicode && hasColor && platform[hasUnicode][!hasColor]) {
      hasColor = false
    } else if (platform === this.defaults.fallback) {
      throw this.newMissingDefaultThemeError(platformName, hasUnicode, hasColor)
    }
  }
  if (platform[hasUnicode][hasColor]) {
    return this.getTheme(platform[hasUnicode][hasColor])
  } else {
    return this.getDefault(objectAssign({}, opts, {platform: 'fallback'}))
  }
}

ThemeSetProto.newMissingThemeError = function newMissingThemeError (name) {
  var err = new Error('Could not find a gauge theme named "' + name + '"')
  Error.captureStackTrace.call(err, newMissingThemeError)
  err.theme = name
  err.code = 'EMISSINGTHEME'
  return err
}

ThemeSetProto.newMissingDefaultThemeError = function newMissingDefaultThemeError (platformName, hasUnicode, hasColor) {
  var err = new Error(
    'Could not find a gauge theme for your platform/unicode/color use combo:\n' +
    '    platform = ' + platformName + '\n' +
    '    hasUnicode = ' + hasUnicode + '\n' +
    '    hasColor = ' + hasColor)
  Error.captureStackTrace.call(err, newMissingDefaultThemeError)
  err.platform = platformName
  err.hasUnicode = hasUnicode
  err.hasColor = hasColor
  err.code = 'EMISSINGTHEME'
  return err
}

ThemeSetProto.newThemeSet = function () {
  var themeset = function (opts) {
    return themeset.getDefault(opts)
  }
  return objectAssign(themeset, ThemeSetProto, {
    themes: objectAssign({}, this.themes),
    baseTheme: objectAssign({}, this.baseTheme),
    defaults: JSON.parse(JSON.stringify(this.defaults || {}))
  })
}


}).call(this,_dereq_('_process'))
},{"./base-theme.js":55,"_process":20,"object-assign":61}],81:[function(_dereq_,module,exports){
'use strict'
var consoleControl = _dereq_('console-control-strings')
var ThemeSet = _dereq_('./theme-set.js')

var themes = module.exports = new ThemeSet()

themes.addTheme('ASCII', {
  preProgressbar: '[',
  postProgressbar: ']',
  progressbarTheme: {
    complete: '#',
    remaining: '.'
  },
  activityIndicatorTheme: '-\\|/',
  preSubsection: '>'
})

themes.addTheme('colorASCII', themes.getTheme('ASCII'), {
  progressbarTheme: {
    preComplete: consoleControl.color('inverse'),
    complete: ' ',
    postComplete: consoleControl.color('stopInverse'),
    preRemaining: consoleControl.color('brightBlack'),
    remaining: '.',
    postRemaining: consoleControl.color('reset')
  }
})

themes.addTheme('brailleSpinner', {
  preProgressbar: '⸨',
  postProgressbar: '⸩',
  progressbarTheme: {
    complete: '░',
    remaining: '⠂'
  },
  activityIndicatorTheme: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
  preSubsection: '>'
})

themes.addTheme('colorBrailleSpinner', themes.getTheme('brailleSpinner'), {
  progressbarTheme: {
    preComplete: consoleControl.color('inverse'),
    complete: ' ',
    postComplete: consoleControl.color('stopInverse'),
    preRemaining: consoleControl.color('brightBlack'),
    remaining: '░',
    postRemaining: consoleControl.color('reset')
  }
})

themes.setDefault({}, 'ASCII')
themes.setDefault({hasColor: true}, 'colorASCII')
themes.setDefault({platform: 'darwin', hasUnicode: true}, 'brailleSpinner')
themes.setDefault({platform: 'darwin', hasUnicode: true, hasColor: true}, 'colorBrailleSpinner')

},{"./theme-set.js":80,"console-control-strings":54}],82:[function(_dereq_,module,exports){
'use strict'
var stringWidth = _dereq_('string-width')
var stripAnsi = _dereq_('strip-ansi')

module.exports = wideTruncate

function wideTruncate (str, target) {
  if (stringWidth(str) === 0) return str
  if (target <= 0) return ''
  if (stringWidth(str) <= target) return str

  // We compute the number of bytes of ansi sequences here and add
  // that to our initial truncation to ensure that we don't slice one
  // that we want to keep in half.
  var noAnsi = stripAnsi(str)
  var ansiSize = str.length + noAnsi.length
  var truncated = str.slice(0, target + ansiSize)

  // we have to shrink the result to account for our ansi sequence buffer
  // (if an ansi sequence was truncated) and double width characters.
  while (stringWidth(truncated) > target) {
    truncated = truncated.slice(0, -1)
  }
  return truncated
}

},{"string-width":64,"strip-ansi":69}],83:[function(_dereq_,module,exports){
(function (process){
module.exports = function (blocking) {
  [process.stdout, process.stderr].forEach(function (stream) {
    if (stream._handle && stream.isTTY && typeof stream._handle.setBlocking === 'function') {
      stream._handle.setBlocking(blocking)
    }
  })
}

}).call(this,_dereq_('_process'))
},{"_process":20}],84:[function(_dereq_,module,exports){
(function (process){
exports = module.exports = SemVer;

// The debug function is excluded entirely from the minified version.
/* nomin */ var debug;
/* nomin */ if (typeof process === 'object' &&
    /* nomin */ process.env &&
    /* nomin */ process.env.NODE_DEBUG &&
    /* nomin */ /\bsemver\b/i.test(process.env.NODE_DEBUG))
  /* nomin */ debug = function() {
    /* nomin */ var args = Array.prototype.slice.call(arguments, 0);
    /* nomin */ args.unshift('SEMVER');
    /* nomin */ console.log.apply(console, args);
    /* nomin */ };
/* nomin */ else
  /* nomin */ debug = function() {};

// Note: this is the semver.org version of the spec that it implements
// Not necessarily the package version of this code.
exports.SEMVER_SPEC_VERSION = '2.0.0';

var MAX_LENGTH = 256;
var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || 9007199254740991;

// The actual regexps go on exports.re
var re = exports.re = [];
var src = exports.src = [];
var R = 0;

// The following Regular Expressions can be used for tokenizing,
// validating, and parsing SemVer version strings.

// ## Numeric Identifier
// A single `0`, or a non-zero digit followed by zero or more digits.

var NUMERICIDENTIFIER = R++;
src[NUMERICIDENTIFIER] = '0|[1-9]\\d*';
var NUMERICIDENTIFIERLOOSE = R++;
src[NUMERICIDENTIFIERLOOSE] = '[0-9]+';


// ## Non-numeric Identifier
// Zero or more digits, followed by a letter or hyphen, and then zero or
// more letters, digits, or hyphens.

var NONNUMERICIDENTIFIER = R++;
src[NONNUMERICIDENTIFIER] = '\\d*[a-zA-Z-][a-zA-Z0-9-]*';


// ## Main Version
// Three dot-separated numeric identifiers.

var MAINVERSION = R++;
src[MAINVERSION] = '(' + src[NUMERICIDENTIFIER] + ')\\.' +
                   '(' + src[NUMERICIDENTIFIER] + ')\\.' +
                   '(' + src[NUMERICIDENTIFIER] + ')';

var MAINVERSIONLOOSE = R++;
src[MAINVERSIONLOOSE] = '(' + src[NUMERICIDENTIFIERLOOSE] + ')\\.' +
                        '(' + src[NUMERICIDENTIFIERLOOSE] + ')\\.' +
                        '(' + src[NUMERICIDENTIFIERLOOSE] + ')';

// ## Pre-release Version Identifier
// A numeric identifier, or a non-numeric identifier.

var PRERELEASEIDENTIFIER = R++;
src[PRERELEASEIDENTIFIER] = '(?:' + src[NUMERICIDENTIFIER] +
                            '|' + src[NONNUMERICIDENTIFIER] + ')';

var PRERELEASEIDENTIFIERLOOSE = R++;
src[PRERELEASEIDENTIFIERLOOSE] = '(?:' + src[NUMERICIDENTIFIERLOOSE] +
                                 '|' + src[NONNUMERICIDENTIFIER] + ')';


// ## Pre-release Version
// Hyphen, followed by one or more dot-separated pre-release version
// identifiers.

var PRERELEASE = R++;
src[PRERELEASE] = '(?:-(' + src[PRERELEASEIDENTIFIER] +
                  '(?:\\.' + src[PRERELEASEIDENTIFIER] + ')*))';

var PRERELEASELOOSE = R++;
src[PRERELEASELOOSE] = '(?:-?(' + src[PRERELEASEIDENTIFIERLOOSE] +
                       '(?:\\.' + src[PRERELEASEIDENTIFIERLOOSE] + ')*))';

// ## Build Metadata Identifier
// Any combination of digits, letters, or hyphens.

var BUILDIDENTIFIER = R++;
src[BUILDIDENTIFIER] = '[0-9A-Za-z-]+';

// ## Build Metadata
// Plus sign, followed by one or more period-separated build metadata
// identifiers.

var BUILD = R++;
src[BUILD] = '(?:\\+(' + src[BUILDIDENTIFIER] +
             '(?:\\.' + src[BUILDIDENTIFIER] + ')*))';


// ## Full Version String
// A main version, followed optionally by a pre-release version and
// build metadata.

// Note that the only major, minor, patch, and pre-release sections of
// the version string are capturing groups.  The build metadata is not a
// capturing group, because it should not ever be used in version
// comparison.

var FULL = R++;
var FULLPLAIN = 'v?' + src[MAINVERSION] +
                src[PRERELEASE] + '?' +
                src[BUILD] + '?';

src[FULL] = '^' + FULLPLAIN + '$';

// like full, but allows v1.2.3 and =1.2.3, which people do sometimes.
// also, 1.0.0alpha1 (prerelease without the hyphen) which is pretty
// common in the npm registry.
var LOOSEPLAIN = '[v=\\s]*' + src[MAINVERSIONLOOSE] +
                 src[PRERELEASELOOSE] + '?' +
                 src[BUILD] + '?';

var LOOSE = R++;
src[LOOSE] = '^' + LOOSEPLAIN + '$';

var GTLT = R++;
src[GTLT] = '((?:<|>)?=?)';

// Something like "2.*" or "1.2.x".
// Note that "x.x" is a valid xRange identifer, meaning "any version"
// Only the first item is strictly required.
var XRANGEIDENTIFIERLOOSE = R++;
src[XRANGEIDENTIFIERLOOSE] = src[NUMERICIDENTIFIERLOOSE] + '|x|X|\\*';
var XRANGEIDENTIFIER = R++;
src[XRANGEIDENTIFIER] = src[NUMERICIDENTIFIER] + '|x|X|\\*';

var XRANGEPLAIN = R++;
src[XRANGEPLAIN] = '[v=\\s]*(' + src[XRANGEIDENTIFIER] + ')' +
                   '(?:\\.(' + src[XRANGEIDENTIFIER] + ')' +
                   '(?:\\.(' + src[XRANGEIDENTIFIER] + ')' +
                   '(?:' + src[PRERELEASE] + ')?' +
                   src[BUILD] + '?' +
                   ')?)?';

var XRANGEPLAINLOOSE = R++;
src[XRANGEPLAINLOOSE] = '[v=\\s]*(' + src[XRANGEIDENTIFIERLOOSE] + ')' +
                        '(?:\\.(' + src[XRANGEIDENTIFIERLOOSE] + ')' +
                        '(?:\\.(' + src[XRANGEIDENTIFIERLOOSE] + ')' +
                        '(?:' + src[PRERELEASELOOSE] + ')?' +
                        src[BUILD] + '?' +
                        ')?)?';

var XRANGE = R++;
src[XRANGE] = '^' + src[GTLT] + '\\s*' + src[XRANGEPLAIN] + '$';
var XRANGELOOSE = R++;
src[XRANGELOOSE] = '^' + src[GTLT] + '\\s*' + src[XRANGEPLAINLOOSE] + '$';

// Tilde ranges.
// Meaning is "reasonably at or greater than"
var LONETILDE = R++;
src[LONETILDE] = '(?:~>?)';

var TILDETRIM = R++;
src[TILDETRIM] = '(\\s*)' + src[LONETILDE] + '\\s+';
re[TILDETRIM] = new RegExp(src[TILDETRIM], 'g');
var tildeTrimReplace = '$1~';

var TILDE = R++;
src[TILDE] = '^' + src[LONETILDE] + src[XRANGEPLAIN] + '$';
var TILDELOOSE = R++;
src[TILDELOOSE] = '^' + src[LONETILDE] + src[XRANGEPLAINLOOSE] + '$';

// Caret ranges.
// Meaning is "at least and backwards compatible with"
var LONECARET = R++;
src[LONECARET] = '(?:\\^)';

var CARETTRIM = R++;
src[CARETTRIM] = '(\\s*)' + src[LONECARET] + '\\s+';
re[CARETTRIM] = new RegExp(src[CARETTRIM], 'g');
var caretTrimReplace = '$1^';

var CARET = R++;
src[CARET] = '^' + src[LONECARET] + src[XRANGEPLAIN] + '$';
var CARETLOOSE = R++;
src[CARETLOOSE] = '^' + src[LONECARET] + src[XRANGEPLAINLOOSE] + '$';

// A simple gt/lt/eq thing, or just "" to indicate "any version"
var COMPARATORLOOSE = R++;
src[COMPARATORLOOSE] = '^' + src[GTLT] + '\\s*(' + LOOSEPLAIN + ')$|^$';
var COMPARATOR = R++;
src[COMPARATOR] = '^' + src[GTLT] + '\\s*(' + FULLPLAIN + ')$|^$';


// An expression to strip any whitespace between the gtlt and the thing
// it modifies, so that `> 1.2.3` ==> `>1.2.3`
var COMPARATORTRIM = R++;
src[COMPARATORTRIM] = '(\\s*)' + src[GTLT] +
                      '\\s*(' + LOOSEPLAIN + '|' + src[XRANGEPLAIN] + ')';

// this one has to use the /g flag
re[COMPARATORTRIM] = new RegExp(src[COMPARATORTRIM], 'g');
var comparatorTrimReplace = '$1$2$3';


// Something like `1.2.3 - 1.2.4`
// Note that these all use the loose form, because they'll be
// checked against either the strict or loose comparator form
// later.
var HYPHENRANGE = R++;
src[HYPHENRANGE] = '^\\s*(' + src[XRANGEPLAIN] + ')' +
                   '\\s+-\\s+' +
                   '(' + src[XRANGEPLAIN] + ')' +
                   '\\s*$';

var HYPHENRANGELOOSE = R++;
src[HYPHENRANGELOOSE] = '^\\s*(' + src[XRANGEPLAINLOOSE] + ')' +
                        '\\s+-\\s+' +
                        '(' + src[XRANGEPLAINLOOSE] + ')' +
                        '\\s*$';

// Star ranges basically just allow anything at all.
var STAR = R++;
src[STAR] = '(<|>)?=?\\s*\\*';

// Compile to actual regexp objects.
// All are flag-free, unless they were created above with a flag.
for (var i = 0; i < R; i++) {
  debug(i, src[i]);
  if (!re[i])
    re[i] = new RegExp(src[i]);
}

exports.parse = parse;
function parse(version, loose) {
  if (version instanceof SemVer)
    return version;

  if (typeof version !== 'string')
    return null;

  if (version.length > MAX_LENGTH)
    return null;

  var r = loose ? re[LOOSE] : re[FULL];
  if (!r.test(version))
    return null;

  try {
    return new SemVer(version, loose);
  } catch (er) {
    return null;
  }
}

exports.valid = valid;
function valid(version, loose) {
  var v = parse(version, loose);
  return v ? v.version : null;
}


exports.clean = clean;
function clean(version, loose) {
  var s = parse(version.trim().replace(/^[=v]+/, ''), loose);
  return s ? s.version : null;
}

exports.SemVer = SemVer;

function SemVer(version, loose) {
  if (version instanceof SemVer) {
    if (version.loose === loose)
      return version;
    else
      version = version.version;
  } else if (typeof version !== 'string') {
    throw new TypeError('Invalid Version: ' + version);
  }

  if (version.length > MAX_LENGTH)
    throw new TypeError('version is longer than ' + MAX_LENGTH + ' characters')

  if (!(this instanceof SemVer))
    return new SemVer(version, loose);

  debug('SemVer', version, loose);
  this.loose = loose;
  var m = version.trim().match(loose ? re[LOOSE] : re[FULL]);

  if (!m)
    throw new TypeError('Invalid Version: ' + version);

  this.raw = version;

  // these are actually numbers
  this.major = +m[1];
  this.minor = +m[2];
  this.patch = +m[3];

  if (this.major > MAX_SAFE_INTEGER || this.major < 0)
    throw new TypeError('Invalid major version')

  if (this.minor > MAX_SAFE_INTEGER || this.minor < 0)
    throw new TypeError('Invalid minor version')

  if (this.patch > MAX_SAFE_INTEGER || this.patch < 0)
    throw new TypeError('Invalid patch version')

  // numberify any prerelease numeric ids
  if (!m[4])
    this.prerelease = [];
  else
    this.prerelease = m[4].split('.').map(function(id) {
      if (/^[0-9]+$/.test(id)) {
        var num = +id;
        if (num >= 0 && num < MAX_SAFE_INTEGER)
          return num;
      }
      return id;
    });

  this.build = m[5] ? m[5].split('.') : [];
  this.format();
}

SemVer.prototype.format = function() {
  this.version = this.major + '.' + this.minor + '.' + this.patch;
  if (this.prerelease.length)
    this.version += '-' + this.prerelease.join('.');
  return this.version;
};

SemVer.prototype.toString = function() {
  return this.version;
};

SemVer.prototype.compare = function(other) {
  debug('SemVer.compare', this.version, this.loose, other);
  if (!(other instanceof SemVer))
    other = new SemVer(other, this.loose);

  return this.compareMain(other) || this.comparePre(other);
};

SemVer.prototype.compareMain = function(other) {
  if (!(other instanceof SemVer))
    other = new SemVer(other, this.loose);

  return compareIdentifiers(this.major, other.major) ||
         compareIdentifiers(this.minor, other.minor) ||
         compareIdentifiers(this.patch, other.patch);
};

SemVer.prototype.comparePre = function(other) {
  if (!(other instanceof SemVer))
    other = new SemVer(other, this.loose);

  // NOT having a prerelease is > having one
  if (this.prerelease.length && !other.prerelease.length)
    return -1;
  else if (!this.prerelease.length && other.prerelease.length)
    return 1;
  else if (!this.prerelease.length && !other.prerelease.length)
    return 0;

  var i = 0;
  do {
    var a = this.prerelease[i];
    var b = other.prerelease[i];
    debug('prerelease compare', i, a, b);
    if (a === undefined && b === undefined)
      return 0;
    else if (b === undefined)
      return 1;
    else if (a === undefined)
      return -1;
    else if (a === b)
      continue;
    else
      return compareIdentifiers(a, b);
  } while (++i);
};

// preminor will bump the version up to the next minor release, and immediately
// down to pre-release. premajor and prepatch work the same way.
SemVer.prototype.inc = function(release, identifier) {
  switch (release) {
    case 'premajor':
      this.prerelease.length = 0;
      this.patch = 0;
      this.minor = 0;
      this.major++;
      this.inc('pre', identifier);
      break;
    case 'preminor':
      this.prerelease.length = 0;
      this.patch = 0;
      this.minor++;
      this.inc('pre', identifier);
      break;
    case 'prepatch':
      // If this is already a prerelease, it will bump to the next version
      // drop any prereleases that might already exist, since they are not
      // relevant at this point.
      this.prerelease.length = 0;
      this.inc('patch', identifier);
      this.inc('pre', identifier);
      break;
    // If the input is a non-prerelease version, this acts the same as
    // prepatch.
    case 'prerelease':
      if (this.prerelease.length === 0)
        this.inc('patch', identifier);
      this.inc('pre', identifier);
      break;

    case 'major':
      // If this is a pre-major version, bump up to the same major version.
      // Otherwise increment major.
      // 1.0.0-5 bumps to 1.0.0
      // 1.1.0 bumps to 2.0.0
      if (this.minor !== 0 || this.patch !== 0 || this.prerelease.length === 0)
        this.major++;
      this.minor = 0;
      this.patch = 0;
      this.prerelease = [];
      break;
    case 'minor':
      // If this is a pre-minor version, bump up to the same minor version.
      // Otherwise increment minor.
      // 1.2.0-5 bumps to 1.2.0
      // 1.2.1 bumps to 1.3.0
      if (this.patch !== 0 || this.prerelease.length === 0)
        this.minor++;
      this.patch = 0;
      this.prerelease = [];
      break;
    case 'patch':
      // If this is not a pre-release version, it will increment the patch.
      // If it is a pre-release it will bump up to the same patch version.
      // 1.2.0-5 patches to 1.2.0
      // 1.2.0 patches to 1.2.1
      if (this.prerelease.length === 0)
        this.patch++;
      this.prerelease = [];
      break;
    // This probably shouldn't be used publicly.
    // 1.0.0 "pre" would become 1.0.0-0 which is the wrong direction.
    case 'pre':
      if (this.prerelease.length === 0)
        this.prerelease = [0];
      else {
        var i = this.prerelease.length;
        while (--i >= 0) {
          if (typeof this.prerelease[i] === 'number') {
            this.prerelease[i]++;
            i = -2;
          }
        }
        if (i === -1) // didn't increment anything
          this.prerelease.push(0);
      }
      if (identifier) {
        // 1.2.0-beta.1 bumps to 1.2.0-beta.2,
        // 1.2.0-beta.fooblz or 1.2.0-beta bumps to 1.2.0-beta.0
        if (this.prerelease[0] === identifier) {
          if (isNaN(this.prerelease[1]))
            this.prerelease = [identifier, 0];
        } else
          this.prerelease = [identifier, 0];
      }
      break;

    default:
      throw new Error('invalid increment argument: ' + release);
  }
  this.format();
  this.raw = this.version;
  return this;
};

exports.inc = inc;
function inc(version, release, loose, identifier) {
  if (typeof(loose) === 'string') {
    identifier = loose;
    loose = undefined;
  }

  try {
    return new SemVer(version, loose).inc(release, identifier).version;
  } catch (er) {
    return null;
  }
}

exports.diff = diff;
function diff(version1, version2) {
  if (eq(version1, version2)) {
    return null;
  } else {
    var v1 = parse(version1);
    var v2 = parse(version2);
    if (v1.prerelease.length || v2.prerelease.length) {
      for (var key in v1) {
        if (key === 'major' || key === 'minor' || key === 'patch') {
          if (v1[key] !== v2[key]) {
            return 'pre'+key;
          }
        }
      }
      return 'prerelease';
    }
    for (var key in v1) {
      if (key === 'major' || key === 'minor' || key === 'patch') {
        if (v1[key] !== v2[key]) {
          return key;
        }
      }
    }
  }
}

exports.compareIdentifiers = compareIdentifiers;

var numeric = /^[0-9]+$/;
function compareIdentifiers(a, b) {
  var anum = numeric.test(a);
  var bnum = numeric.test(b);

  if (anum && bnum) {
    a = +a;
    b = +b;
  }

  return (anum && !bnum) ? -1 :
         (bnum && !anum) ? 1 :
         a < b ? -1 :
         a > b ? 1 :
         0;
}

exports.rcompareIdentifiers = rcompareIdentifiers;
function rcompareIdentifiers(a, b) {
  return compareIdentifiers(b, a);
}

exports.major = major;
function major(a, loose) {
  return new SemVer(a, loose).major;
}

exports.minor = minor;
function minor(a, loose) {
  return new SemVer(a, loose).minor;
}

exports.patch = patch;
function patch(a, loose) {
  return new SemVer(a, loose).patch;
}

exports.compare = compare;
function compare(a, b, loose) {
  return new SemVer(a, loose).compare(b);
}

exports.compareLoose = compareLoose;
function compareLoose(a, b) {
  return compare(a, b, true);
}

exports.rcompare = rcompare;
function rcompare(a, b, loose) {
  return compare(b, a, loose);
}

exports.sort = sort;
function sort(list, loose) {
  return list.sort(function(a, b) {
    return exports.compare(a, b, loose);
  });
}

exports.rsort = rsort;
function rsort(list, loose) {
  return list.sort(function(a, b) {
    return exports.rcompare(a, b, loose);
  });
}

exports.gt = gt;
function gt(a, b, loose) {
  return compare(a, b, loose) > 0;
}

exports.lt = lt;
function lt(a, b, loose) {
  return compare(a, b, loose) < 0;
}

exports.eq = eq;
function eq(a, b, loose) {
  return compare(a, b, loose) === 0;
}

exports.neq = neq;
function neq(a, b, loose) {
  return compare(a, b, loose) !== 0;
}

exports.gte = gte;
function gte(a, b, loose) {
  return compare(a, b, loose) >= 0;
}

exports.lte = lte;
function lte(a, b, loose) {
  return compare(a, b, loose) <= 0;
}

exports.cmp = cmp;
function cmp(a, op, b, loose) {
  var ret;
  switch (op) {
    case '===':
      if (typeof a === 'object') a = a.version;
      if (typeof b === 'object') b = b.version;
      ret = a === b;
      break;
    case '!==':
      if (typeof a === 'object') a = a.version;
      if (typeof b === 'object') b = b.version;
      ret = a !== b;
      break;
    case '': case '=': case '==': ret = eq(a, b, loose); break;
    case '!=': ret = neq(a, b, loose); break;
    case '>': ret = gt(a, b, loose); break;
    case '>=': ret = gte(a, b, loose); break;
    case '<': ret = lt(a, b, loose); break;
    case '<=': ret = lte(a, b, loose); break;
    default: throw new TypeError('Invalid operator: ' + op);
  }
  return ret;
}

exports.Comparator = Comparator;
function Comparator(comp, loose) {
  if (comp instanceof Comparator) {
    if (comp.loose === loose)
      return comp;
    else
      comp = comp.value;
  }

  if (!(this instanceof Comparator))
    return new Comparator(comp, loose);

  debug('comparator', comp, loose);
  this.loose = loose;
  this.parse(comp);

  if (this.semver === ANY)
    this.value = '';
  else
    this.value = this.operator + this.semver.version;

  debug('comp', this);
}

var ANY = {};
Comparator.prototype.parse = function(comp) {
  var r = this.loose ? re[COMPARATORLOOSE] : re[COMPARATOR];
  var m = comp.match(r);

  if (!m)
    throw new TypeError('Invalid comparator: ' + comp);

  this.operator = m[1];
  if (this.operator === '=')
    this.operator = '';

  // if it literally is just '>' or '' then allow anything.
  if (!m[2])
    this.semver = ANY;
  else
    this.semver = new SemVer(m[2], this.loose);
};

Comparator.prototype.toString = function() {
  return this.value;
};

Comparator.prototype.test = function(version) {
  debug('Comparator.test', version, this.loose);

  if (this.semver === ANY)
    return true;

  if (typeof version === 'string')
    version = new SemVer(version, this.loose);

  return cmp(version, this.operator, this.semver, this.loose);
};


exports.Range = Range;
function Range(range, loose) {
  if ((range instanceof Range) && range.loose === loose)
    return range;

  if (!(this instanceof Range))
    return new Range(range, loose);

  this.loose = loose;

  // First, split based on boolean or ||
  this.raw = range;
  this.set = range.split(/\s*\|\|\s*/).map(function(range) {
    return this.parseRange(range.trim());
  }, this).filter(function(c) {
    // throw out any that are not relevant for whatever reason
    return c.length;
  });

  if (!this.set.length) {
    throw new TypeError('Invalid SemVer Range: ' + range);
  }

  this.format();
}

Range.prototype.format = function() {
  this.range = this.set.map(function(comps) {
    return comps.join(' ').trim();
  }).join('||').trim();
  return this.range;
};

Range.prototype.toString = function() {
  return this.range;
};

Range.prototype.parseRange = function(range) {
  var loose = this.loose;
  range = range.trim();
  debug('range', range, loose);
  // `1.2.3 - 1.2.4` => `>=1.2.3 <=1.2.4`
  var hr = loose ? re[HYPHENRANGELOOSE] : re[HYPHENRANGE];
  range = range.replace(hr, hyphenReplace);
  debug('hyphen replace', range);
  // `> 1.2.3 < 1.2.5` => `>1.2.3 <1.2.5`
  range = range.replace(re[COMPARATORTRIM], comparatorTrimReplace);
  debug('comparator trim', range, re[COMPARATORTRIM]);

  // `~ 1.2.3` => `~1.2.3`
  range = range.replace(re[TILDETRIM], tildeTrimReplace);

  // `^ 1.2.3` => `^1.2.3`
  range = range.replace(re[CARETTRIM], caretTrimReplace);

  // normalize spaces
  range = range.split(/\s+/).join(' ');

  // At this point, the range is completely trimmed and
  // ready to be split into comparators.

  var compRe = loose ? re[COMPARATORLOOSE] : re[COMPARATOR];
  var set = range.split(' ').map(function(comp) {
    return parseComparator(comp, loose);
  }).join(' ').split(/\s+/);
  if (this.loose) {
    // in loose mode, throw out any that are not valid comparators
    set = set.filter(function(comp) {
      return !!comp.match(compRe);
    });
  }
  set = set.map(function(comp) {
    return new Comparator(comp, loose);
  });

  return set;
};

// Mostly just for testing and legacy API reasons
exports.toComparators = toComparators;
function toComparators(range, loose) {
  return new Range(range, loose).set.map(function(comp) {
    return comp.map(function(c) {
      return c.value;
    }).join(' ').trim().split(' ');
  });
}

// comprised of xranges, tildes, stars, and gtlt's at this point.
// already replaced the hyphen ranges
// turn into a set of JUST comparators.
function parseComparator(comp, loose) {
  debug('comp', comp);
  comp = replaceCarets(comp, loose);
  debug('caret', comp);
  comp = replaceTildes(comp, loose);
  debug('tildes', comp);
  comp = replaceXRanges(comp, loose);
  debug('xrange', comp);
  comp = replaceStars(comp, loose);
  debug('stars', comp);
  return comp;
}

function isX(id) {
  return !id || id.toLowerCase() === 'x' || id === '*';
}

// ~, ~> --> * (any, kinda silly)
// ~2, ~2.x, ~2.x.x, ~>2, ~>2.x ~>2.x.x --> >=2.0.0 <3.0.0
// ~2.0, ~2.0.x, ~>2.0, ~>2.0.x --> >=2.0.0 <2.1.0
// ~1.2, ~1.2.x, ~>1.2, ~>1.2.x --> >=1.2.0 <1.3.0
// ~1.2.3, ~>1.2.3 --> >=1.2.3 <1.3.0
// ~1.2.0, ~>1.2.0 --> >=1.2.0 <1.3.0
function replaceTildes(comp, loose) {
  return comp.trim().split(/\s+/).map(function(comp) {
    return replaceTilde(comp, loose);
  }).join(' ');
}

function replaceTilde(comp, loose) {
  var r = loose ? re[TILDELOOSE] : re[TILDE];
  return comp.replace(r, function(_, M, m, p, pr) {
    debug('tilde', comp, _, M, m, p, pr);
    var ret;

    if (isX(M))
      ret = '';
    else if (isX(m))
      ret = '>=' + M + '.0.0 <' + (+M + 1) + '.0.0';
    else if (isX(p))
      // ~1.2 == >=1.2.0 <1.3.0
      ret = '>=' + M + '.' + m + '.0 <' + M + '.' + (+m + 1) + '.0';
    else if (pr) {
      debug('replaceTilde pr', pr);
      if (pr.charAt(0) !== '-')
        pr = '-' + pr;
      ret = '>=' + M + '.' + m + '.' + p + pr +
            ' <' + M + '.' + (+m + 1) + '.0';
    } else
      // ~1.2.3 == >=1.2.3 <1.3.0
      ret = '>=' + M + '.' + m + '.' + p +
            ' <' + M + '.' + (+m + 1) + '.0';

    debug('tilde return', ret);
    return ret;
  });
}

// ^ --> * (any, kinda silly)
// ^2, ^2.x, ^2.x.x --> >=2.0.0 <3.0.0
// ^2.0, ^2.0.x --> >=2.0.0 <3.0.0
// ^1.2, ^1.2.x --> >=1.2.0 <2.0.0
// ^1.2.3 --> >=1.2.3 <2.0.0
// ^1.2.0 --> >=1.2.0 <2.0.0
function replaceCarets(comp, loose) {
  return comp.trim().split(/\s+/).map(function(comp) {
    return replaceCaret(comp, loose);
  }).join(' ');
}

function replaceCaret(comp, loose) {
  debug('caret', comp, loose);
  var r = loose ? re[CARETLOOSE] : re[CARET];
  return comp.replace(r, function(_, M, m, p, pr) {
    debug('caret', comp, _, M, m, p, pr);
    var ret;

    if (isX(M))
      ret = '';
    else if (isX(m))
      ret = '>=' + M + '.0.0 <' + (+M + 1) + '.0.0';
    else if (isX(p)) {
      if (M === '0')
        ret = '>=' + M + '.' + m + '.0 <' + M + '.' + (+m + 1) + '.0';
      else
        ret = '>=' + M + '.' + m + '.0 <' + (+M + 1) + '.0.0';
    } else if (pr) {
      debug('replaceCaret pr', pr);
      if (pr.charAt(0) !== '-')
        pr = '-' + pr;
      if (M === '0') {
        if (m === '0')
          ret = '>=' + M + '.' + m + '.' + p + pr +
                ' <' + M + '.' + m + '.' + (+p + 1);
        else
          ret = '>=' + M + '.' + m + '.' + p + pr +
                ' <' + M + '.' + (+m + 1) + '.0';
      } else
        ret = '>=' + M + '.' + m + '.' + p + pr +
              ' <' + (+M + 1) + '.0.0';
    } else {
      debug('no pr');
      if (M === '0') {
        if (m === '0')
          ret = '>=' + M + '.' + m + '.' + p +
                ' <' + M + '.' + m + '.' + (+p + 1);
        else
          ret = '>=' + M + '.' + m + '.' + p +
                ' <' + M + '.' + (+m + 1) + '.0';
      } else
        ret = '>=' + M + '.' + m + '.' + p +
              ' <' + (+M + 1) + '.0.0';
    }

    debug('caret return', ret);
    return ret;
  });
}

function replaceXRanges(comp, loose) {
  debug('replaceXRanges', comp, loose);
  return comp.split(/\s+/).map(function(comp) {
    return replaceXRange(comp, loose);
  }).join(' ');
}

function replaceXRange(comp, loose) {
  comp = comp.trim();
  var r = loose ? re[XRANGELOOSE] : re[XRANGE];
  return comp.replace(r, function(ret, gtlt, M, m, p, pr) {
    debug('xRange', comp, ret, gtlt, M, m, p, pr);
    var xM = isX(M);
    var xm = xM || isX(m);
    var xp = xm || isX(p);
    var anyX = xp;

    if (gtlt === '=' && anyX)
      gtlt = '';

    if (xM) {
      if (gtlt === '>' || gtlt === '<') {
        // nothing is allowed
        ret = '<0.0.0';
      } else {
        // nothing is forbidden
        ret = '*';
      }
    } else if (gtlt && anyX) {
      // replace X with 0
      if (xm)
        m = 0;
      if (xp)
        p = 0;

      if (gtlt === '>') {
        // >1 => >=2.0.0
        // >1.2 => >=1.3.0
        // >1.2.3 => >= 1.2.4
        gtlt = '>=';
        if (xm) {
          M = +M + 1;
          m = 0;
          p = 0;
        } else if (xp) {
          m = +m + 1;
          p = 0;
        }
      } else if (gtlt === '<=') {
        // <=0.7.x is actually <0.8.0, since any 0.7.x should
        // pass.  Similarly, <=7.x is actually <8.0.0, etc.
        gtlt = '<';
        if (xm)
          M = +M + 1;
        else
          m = +m + 1;
      }

      ret = gtlt + M + '.' + m + '.' + p;
    } else if (xm) {
      ret = '>=' + M + '.0.0 <' + (+M + 1) + '.0.0';
    } else if (xp) {
      ret = '>=' + M + '.' + m + '.0 <' + M + '.' + (+m + 1) + '.0';
    }

    debug('xRange return', ret);

    return ret;
  });
}

// Because * is AND-ed with everything else in the comparator,
// and '' means "any version", just remove the *s entirely.
function replaceStars(comp, loose) {
  debug('replaceStars', comp, loose);
  // Looseness is ignored here.  star is always as loose as it gets!
  return comp.trim().replace(re[STAR], '');
}

// This function is passed to string.replace(re[HYPHENRANGE])
// M, m, patch, prerelease, build
// 1.2 - 3.4.5 => >=1.2.0 <=3.4.5
// 1.2.3 - 3.4 => >=1.2.0 <3.5.0 Any 3.4.x will do
// 1.2 - 3.4 => >=1.2.0 <3.5.0
function hyphenReplace($0,
                       from, fM, fm, fp, fpr, fb,
                       to, tM, tm, tp, tpr, tb) {

  if (isX(fM))
    from = '';
  else if (isX(fm))
    from = '>=' + fM + '.0.0';
  else if (isX(fp))
    from = '>=' + fM + '.' + fm + '.0';
  else
    from = '>=' + from;

  if (isX(tM))
    to = '';
  else if (isX(tm))
    to = '<' + (+tM + 1) + '.0.0';
  else if (isX(tp))
    to = '<' + tM + '.' + (+tm + 1) + '.0';
  else if (tpr)
    to = '<=' + tM + '.' + tm + '.' + tp + '-' + tpr;
  else
    to = '<=' + to;

  return (from + ' ' + to).trim();
}


// if ANY of the sets match ALL of its comparators, then pass
Range.prototype.test = function(version) {
  if (!version)
    return false;

  if (typeof version === 'string')
    version = new SemVer(version, this.loose);

  for (var i = 0; i < this.set.length; i++) {
    if (testSet(this.set[i], version))
      return true;
  }
  return false;
};

function testSet(set, version) {
  for (var i = 0; i < set.length; i++) {
    if (!set[i].test(version))
      return false;
  }

  if (version.prerelease.length) {
    // Find the set of versions that are allowed to have prereleases
    // For example, ^1.2.3-pr.1 desugars to >=1.2.3-pr.1 <2.0.0
    // That should allow `1.2.3-pr.2` to pass.
    // However, `1.2.4-alpha.notready` should NOT be allowed,
    // even though it's within the range set by the comparators.
    for (var i = 0; i < set.length; i++) {
      debug(set[i].semver);
      if (set[i].semver === ANY)
        continue;

      if (set[i].semver.prerelease.length > 0) {
        var allowed = set[i].semver;
        if (allowed.major === version.major &&
            allowed.minor === version.minor &&
            allowed.patch === version.patch)
          return true;
      }
    }

    // Version has a -pre, but it's not one of the ones we like.
    return false;
  }

  return true;
}

exports.satisfies = satisfies;
function satisfies(version, range, loose) {
  try {
    range = new Range(range, loose);
  } catch (er) {
    return false;
  }
  return range.test(version);
}

exports.maxSatisfying = maxSatisfying;
function maxSatisfying(versions, range, loose) {
  return versions.filter(function(version) {
    return satisfies(version, range, loose);
  }).sort(function(a, b) {
    return rcompare(a, b, loose);
  })[0] || null;
}

exports.minSatisfying = minSatisfying;
function minSatisfying(versions, range, loose) {
  return versions.filter(function(version) {
    return satisfies(version, range, loose);
  }).sort(function(a, b) {
    return compare(a, b, loose);
  })[0] || null;
}

exports.validRange = validRange;
function validRange(range, loose) {
  try {
    // Return '*' instead of '' so that truthiness works.
    // This will throw if it's invalid anyway
    return new Range(range, loose).range || '*';
  } catch (er) {
    return null;
  }
}

// Determine if version is less than all the versions possible in the range
exports.ltr = ltr;
function ltr(version, range, loose) {
  return outside(version, range, '<', loose);
}

// Determine if version is greater than all the versions possible in the range.
exports.gtr = gtr;
function gtr(version, range, loose) {
  return outside(version, range, '>', loose);
}

exports.outside = outside;
function outside(version, range, hilo, loose) {
  version = new SemVer(version, loose);
  range = new Range(range, loose);

  var gtfn, ltefn, ltfn, comp, ecomp;
  switch (hilo) {
    case '>':
      gtfn = gt;
      ltefn = lte;
      ltfn = lt;
      comp = '>';
      ecomp = '>=';
      break;
    case '<':
      gtfn = lt;
      ltefn = gte;
      ltfn = gt;
      comp = '<';
      ecomp = '<=';
      break;
    default:
      throw new TypeError('Must provide a hilo val of "<" or ">"');
  }

  // If it satisifes the range it is not outside
  if (satisfies(version, range, loose)) {
    return false;
  }

  // From now on, variable terms are as if we're in "gtr" mode.
  // but note that everything is flipped for the "ltr" function.

  for (var i = 0; i < range.set.length; ++i) {
    var comparators = range.set[i];

    var high = null;
    var low = null;

    comparators.forEach(function(comparator) {
      if (comparator.semver === ANY) {
        comparator = new Comparator('>=0.0.0')
      }
      high = high || comparator;
      low = low || comparator;
      if (gtfn(comparator.semver, high.semver, loose)) {
        high = comparator;
      } else if (ltfn(comparator.semver, low.semver, loose)) {
        low = comparator;
      }
    });

    // If the edge version comparator has a operator then our version
    // isn't outside it
    if (high.operator === comp || high.operator === ecomp) {
      return false;
    }

    // If the lowest version comparator has an operator and our version
    // is less than it then it isn't higher than the range
    if ((!low.operator || low.operator === comp) &&
        ltefn(version, low.semver)) {
      return false;
    } else if (low.operator === ecomp && ltfn(version, low.semver)) {
      return false;
    }
  }
  return true;
}

exports.prerelease = prerelease;
function prerelease(version, loose) {
  var parsed = parse(version, loose);
  return (parsed && parsed.prerelease.length) ? parsed.prerelease : null;
}

}).call(this,_dereq_('_process'))
},{"_process":20}],85:[function(_dereq_,module,exports){
module.exports={
  "_from": "node-pre-gyp@~0.6.31",
  "_id": "node-pre-gyp@0.6.31",
  "_location": "/sqlite3/node-pre-gyp",
  "_phantomChildren": {},
  "_requiredBy": [
    "/sqlite3"
  ],
  "_shasum": "d8a00ddaa301a940615dbcc8caad4024d58f6017",
  "_shrinkwrap": null,
  "author": {
    "name": "Dane Springmeyer",
    "email": "dane@mapbox.com"
  },
  "bin": {
    "node-pre-gyp": "./bin/node-pre-gyp"
  },
  "bugs": {
    "url": "https://github.com/mapbox/node-pre-gyp/issues"
  },
  "dependencies": {
    "mkdirp": "~0.5.1",
    "nopt": "~3.0.6",
    "npmlog": "^4.0.0",
    "rc": "~1.1.6",
    "request": "^2.75.0",
    "rimraf": "~2.5.4",
    "semver": "~5.3.0",
    "tar": "~2.2.1",
    "tar-pack": "~3.3.0"
  },
  "description": "Node.js native addon binary install tool",
  "devDependencies": {
    "aws-sdk": "2.x",
    "jshint": "2.x",
    "mocha": "3.x",
    "retire": "1.2.10"
  },
  "gitHead": "2c32561503c33728cb8de5a445e76a28868826a8",
  "homepage": "https://github.com/mapbox/node-pre-gyp#readme",
  "jshintConfig": {
    "node": true,
    "globalstrict": true,
    "undef": true,
    "unused": true,
    "noarg": true,
    "mocha": true
  },
  "keywords": [
    "native",
    "addon",
    "module",
    "c",
    "c++",
    "bindings",
    "binary"
  ],
  "license": "BSD-3-Clause",
  "main": "./lib/node-pre-gyp.js",
  "name": "node-pre-gyp",
  "optionalDependencies": {},
  "readme": "# node-pre-gyp\n\n#### node-pre-gyp makes it easy to publish and install Node.js C++ addons from binaries\n\n[![NPM](https://nodei.co/npm/node-pre-gyp.png?downloads=true&downloadRank=true)](https://nodei.co/npm/node-pre-gyp/)\n\n[![Build Status](https://api.travis-ci.org/mapbox/node-pre-gyp.svg)](https://travis-ci.org/mapbox/node-pre-gyp)\n[![Build status](https://ci.appveyor.com/api/projects/status/3nxewb425y83c0gv)](https://ci.appveyor.com/project/Mapbox/node-pre-gyp)\n[![Dependencies](https://david-dm.org/mapbox/node-pre-gyp.svg)](https://david-dm.org/mapbox/node-pre-gyp)\n\n`node-pre-gyp` stands between [npm](https://github.com/npm/npm) and [node-gyp](https://github.com/Tootallnate/node-gyp) and offers a cross-platform method of binary deployment.\n\n### Features\n\n - A command line tool called `node-pre-gyp` that can install your package's C++ module from a binary.\n - A variety of developer targeted commands for packaging, testing, and publishing binaries.\n - A JavaScript module that can dynamically require your installed binary: `require('node-pre-gyp').find`\n\nFor a hello world example of a module packaged with `node-pre-gyp` see <https://github.com/springmeyer/node-addon-example> and [the wiki ](https://github.com/mapbox/node-pre-gyp/wiki/Modules-using-node-pre-gyp) for real world examples.\n\n## Credits\n\n - The module is modeled after [node-gyp](https://github.com/Tootallnate/node-gyp) by [@Tootallnate](https://github.com/Tootallnate)\n - Motivation for initial development came from [@ErisDS](https://github.com/ErisDS) and the [Ghost Project](https://github.com/TryGhost/Ghost).\n - Development is sponsored by [Mapbox](https://www.mapbox.com/)\n\n## FAQ\n\nSee the [Frequently Ask Questions](https://github.com/mapbox/node-pre-gyp/wiki/FAQ).\n\n## Depends\n\n - Node.js >= node v0.10.x\n\n## Install\n\n`node-pre-gyp` is designed to be installed as a local dependency of your Node.js C++ addon and accessed like:\n\n    ./node_modules/.bin/node-pre-gyp --help\n\nBut you can also install it globally:\n\n    npm install node-pre-gyp -g\n\n## Usage\n\n### Commands\n\nView all possible commands:\n\n    node-pre-gyp --help\n\n- clean - Remove the entire folder containing the compiled .node module\n- install - Install pre-built binary for module\n- reinstall - Run \"clean\" and \"install\" at once\n- build - Compile the module by dispatching to node-gyp or nw-gyp\n- rebuild - Run \"clean\" and \"build\" at once\n- package - Pack binary into tarball\n- testpackage - Test that the staged package is valid\n- publish - Publish pre-built binary\n- unpublish - Unpublish pre-built binary\n- info - Fetch info on published binaries\n\nYou can also chain commands:\n\n    node-pre-gyp clean build unpublish publish info\n\n### Options\n\nOptions include:\n\n - `-C/--directory`: run the command in this directory\n - `--build-from-source`: build from source instead of using pre-built binary\n - `--update-binary`: reinstall by replacing previously installed local binary with remote binary\n - `--runtime=node-webkit`: customize the runtime: `node`, `electron` and `node-webkit` are the valid options\n - `--fallback-to-build`: fallback to building from source if pre-built binary is not available\n - `--target=0.10.25`: Pass the target node or node-webkit version to compile against\n - `--target_arch=ia32`: Pass the target arch and override the host `arch`. Valid values are 'ia32','x64', or `arm`.\n - `--target_platform=win32`: Pass the target platform and override the host `platform`. Valid values are `linux`, `darwin`, `win32`, `sunos`, `freebsd`, `openbsd`, and `aix`.\n\nBoth `--build-from-source` and `--fallback-to-build` can be passed alone or they can provide values. You can pass `--fallback-to-build=false` to override the option as declared in package.json. In addition to being able to pass `--build-from-source` you can also pass `--build-from-source=myapp` where `myapp` is the name of your module.\n\nFor example: `npm install --build-from-source=myapp`. This is useful if:\n\n - `myapp` is referenced in the package.json of a larger app and therefore `myapp` is being installed as a dependent with `npm install`.\n - The larger app also depends on other modules installed with `node-pre-gyp`\n - You only want to trigger a source compile for `myapp` and the other modules.\n\n### Configuring\n\nThis is a guide to configuring your module to use node-pre-gyp.\n\n#### 1) Add new entries to your `package.json`\n\n - Add `node-pre-gyp` to `dependencies`\n - Add `aws-sdk` as a `devDependency`\n - Add a custom `install` script\n - Declare a `binary` object\n\nThis looks like:\n\n```js\n    \"dependencies\"  : {\n      \"node-pre-gyp\": \"0.6.x\"\n    },\n    \"devDependencies\": {\n      \"aws-sdk\": \"2.x\"\n    }\n    \"scripts\": {\n        \"preinstall\": \"npm install node-pre-gyp\",\n        \"install\": \"node-pre-gyp install --fallback-to-build\"\n    },\n    \"binary\": {\n        \"module_name\": \"your_module\",\n        \"module_path\": \"./lib/binding/\",\n        \"host\": \"https://your_module.s3-us-west-1.amazonaws.com\"\n    }\n```\n\nFor a full example see [node-addon-examples's package.json](https://github.com/springmeyer/node-addon-example/blob/master/package.json).\n\n##### The `binary` object has three required properties\n\n###### module_name\n\nThe name of your native node module. This value must:\n\n - Match the name passed to [the NODE_MODULE macro](http://nodejs.org/api/addons.html#addons_hello_world)\n - Must be a valid C variable name (e.g. it cannot contain `-`)\n - Should not include the `.node` extension.\n\n###### module_path\n\nThe location your native module is placed after a build. This should be an empty directory without other Javascript files. This entire directory will be packaged in the binary tarball. When installing from a remote package this directory will be overwritten with the contents of the tarball.\n\nNote: This property supports variables based on [Versioning](#versioning).\n\n###### host\n\nA url to the remote location where you've published tarball binaries (must be `https` not `http`).\n\nIt is highly recommended that you use Amazon S3. The reasons are:\n\n  - Various node-pre-gyp commands like `publish` and `info` only work with an S3 host.\n  - S3 is a very solid hosting platform for distributing large files.\n  - We provide detail documentation for using [S3 hosting](#s3-hosting) with node-pre-gyp.\n\nWhy then not require S3? Because while some applications using node-pre-gyp need to distribute binaries as large as 20-30 MB, others might have very small binaries and might wish to store them in a GitHub repo. This is not recommended, but if an author really wants to host in a non-s3 location then it should be possible.\n\nIt should also be mentioned that there is an optional and entirely separate npm module called [node-pre-gyp-github](https://github.com/bchr02/node-pre-gyp-github) which is intended to complement node-pre-gyp and be installed along with it. It provides the ability to store and publish your binaries within your repositories GitHub Releases if you would rather not use S3 directly. Installation and usage instructions can be found [here](https://github.com/bchr02/node-pre-gyp-github), but the basic premise is that instead of using the ```node-pre-gyp publish``` command you would use ```node-pre-gyp-github publish```.\n\n##### The `binary` object has two optional properties\n\n###### remote_path\n\nIt **is recommended** that you customize this property. This is an extra path to use for publishing and finding remote tarballs. The default value for `remote_path` is `\"\"` meaning that if you do not provide it then all packages will be published at the base of the `host`. It is recommended to provide a value like `./{name}/v{version}` to help organize remote packages in the case that you choose to publish multiple node addons to the same `host`.\n\nNote: This property supports variables based on [Versioning](#versioning).\n\n###### package_name\n\nIt is **not recommended** to override this property unless you are also overriding the `remote_path`. This is the versioned name of the remote tarball containing the binary `.node` module and any supporting files you've placed inside the `module_path` directory. Unless you specify `package_name` in your `package.json` then it defaults to `{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz` which allows your binary to work across node versions, platforms, and architectures. If you are using `remote_path` that is also versioned by `./{module_name}/v{version}` then you could remove these variables from the `package_name` and just use: `{node_abi}-{platform}-{arch}.tar.gz`. Then your remote tarball will be looked up at, for example, `https://example.com/your-module/v0.1.0/node-v11-linux-x64.tar.gz`.\n\nAvoiding the version of your module in the `package_name` and instead only embedding in a directory name can be useful when you want to make a quick tag of your module that does not change any C++ code. In this case you can just copy binaries to the new version behind the scenes like:\n\n```sh\naws s3 sync --acl public-read s3://mapbox-node-binary/sqlite3/v3.0.3/ s3://mapbox-node-binary/sqlite3/v3.0.4/\n```\n\nNote: This property supports variables based on [Versioning](#versioning).\n\n#### 2) Add a new target to binding.gyp\n\n`node-pre-gyp` calls out to `node-gyp` to compile the module and passes variables along like [module_name](#module_name) and [module_path](#module_path).\n\nA new target must be added to `binding.gyp` that moves the compiled `.node` module from `./build/Release/module_name.node` into the directory specified by `module_path`.\n\nAdd a target like this at the end of your `targets` list:\n\n```js\n    {\n      \"target_name\": \"action_after_build\",\n      \"type\": \"none\",\n      \"dependencies\": [ \"<(module_name)\" ],\n      \"copies\": [\n        {\n          \"files\": [ \"<(PRODUCT_DIR)/<(module_name).node\" ],\n          \"destination\": \"<(module_path)\"\n        }\n      ]\n    }\n```\n\nFor a full example see [node-addon-example's binding.gyp](https://github.com/springmeyer/node-addon-example/blob/2ff60a8ded7f042864ad21db00c3a5a06cf47075/binding.gyp).\n\n#### 3) Dynamically require your `.node`\n\nInside the main js file that requires your addon module you are likely currently doing:\n\n```js\nvar binding = require('../build/Release/binding.node');\n```\n\nor:\n\n```js\nvar bindings = require('./bindings')\n```\n\nChange those lines to:\n\n```js\nvar binary = require('node-pre-gyp');\nvar path = require('path');\nvar binding_path = binary.find(path.resolve(path.join(__dirname,'./package.json')));\nvar binding = require(binding_path);\n```\n\nFor a full example see [node-addon-example's index.js](https://github.com/springmeyer/node-addon-example/blob/2ff60a8ded7f042864ad21db00c3a5a06cf47075/index.js#L1-L4)\n\n#### 4) Build and package your app\n\nNow build your module from source:\n\n    npm install --build-from-source\n\nThe `--build-from-source` tells `node-pre-gyp` to not look for a remote package and instead dispatch to node-gyp to build.\n\nNow `node-pre-gyp` should now also be installed as a local dependency so the command line tool it offers can be found at `./node_modules/.bin/node-pre-gyp`.\n\n#### 5) Test\n\nNow `npm test` should work just as it did before.\n\n#### 6) Publish the tarball\n\nThen package your app:\n\n    ./node_modules/.bin/node-pre-gyp package\n\nOnce packaged, now you can publish:\n\n    ./node_modules/.bin/node-pre-gyp publish\n\nCurrently the `publish` command pushes your binary to S3. This requires:\n\n - You have installed `aws-sdk` with `npm install aws-sdk`\n - You have created a bucket already.\n - The `host` points to an S3 http or https endpoint.\n - You have configured node-pre-gyp to read your S3 credentials (see [S3 hosting](#s3-hosting) for details).\n\nYou can also host your binaries elsewhere. To do this requires:\n\n - You manually publish the binary created by the `package` command to an `https` endpoint\n - Ensure that the `host` value points to your custom `https` endpoint.\n\n#### 7) Automate builds\n\nNow you need to publish builds for all the platforms and node versions you wish to support. This is best automated.\n\n - See [Appveyor Automation](#appveyor-automation) for how to auto-publish builds on Windows.\n - See [Travis Automation](#travis-automation) for how to auto-publish builds on OS X and Linux.\n\n#### 8) You're done!\n\nNow publish your module to the npm registry. Users will now be able to install your module from a binary.\n\nWhat will happen is this:\n\n1. `npm install <your package>` will pull from the npm registry\n2. npm will run the `install` script which will call out to `node-pre-gyp`\n3. `node-pre-gyp` will fetch the binary `.node` module and unpack in the right place\n4. Assuming that all worked, you are done\n\nIf a a binary was not available for a given platform and `--fallback-to-build` was used then `node-gyp rebuild` will be called to try to source compile the module.\n\n## S3 Hosting\n\nYou can host wherever you choose but S3 is cheap, `node-pre-gyp publish` expects it, and S3 can be integrated well with [Travis.ci](http://travis-ci.org) to automate builds for OS X and Ubuntu, and with [Appveyor](http://appveyor.com) to automate builds for Windows. Here is an approach to do this:\n\nFirst, get setup locally and test the workflow:\n\n#### 1) Create an S3 bucket\n\nAnd have your **key** and **secret key** ready for writing to the bucket.\n\nIt is recommended to create a IAM user with a policy that only gives permissions to the specific bucket you plan to publish to. This can be done in the [IAM console](https://console.aws.amazon.com/iam/) by: 1) adding a new user, 2) choosing `Attach User Policy`, 3) Using the `Policy Generator`, 4) selecting `Amazon S3` for the service, 5) adding the actions: `DeleteObject`, `GetObject`, `GetObjectAcl`, `ListBucket`, `PutObject`, `PutObjectAcl`, 6) adding an ARN of `arn:aws:s3:::bucket/*` (replacing `bucket` with your bucket name), and finally 7) clicking `Add Statement` and saving the policy. It should generate a policy like:\n\n```js\n{\n  \"Version\": \"2012-10-17\",\n  \"Statement\": [\n    {\n      \"Sid\": \"Stmt1394587197000\",\n      \"Effect\": \"Allow\",\n      \"Action\": [\n        \"s3:DeleteObject\",\n        \"s3:GetObject\",\n        \"s3:GetObjectAcl\",\n        \"s3:ListBucket\",\n        \"s3:PutObject\",\n        \"s3:PutObjectAcl\"\n      ],\n      \"Resource\": [\n        \"arn:aws:s3:::node-pre-gyp-tests/*\"\n      ]\n    }\n  ]\n}\n```\n\n#### 2) Install node-pre-gyp\n\nEither install it globally:\n\n    npm install node-pre-gyp -g\n\nOr put the local version on your PATH\n\n    export PATH=`pwd`/node_modules/.bin/:$PATH\n\n#### 3) Configure AWS credentials\n\nThere are several ways to do this.\n\nYou can use any of the methods described at http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html.\n\nOr you can create a `~/.node_pre_gyprc`\n\nOr pass options in any way supported by [RC](https://github.com/dominictarr/rc#standards)\n\nA `~/.node_pre_gyprc` looks like:\n\n```js\n{\n    \"accessKeyId\": \"xxx\",\n    \"secretAccessKey\": \"xxx\"\n}\n```\n\nAnother way is to use your environment:\n\n    export node_pre_gyp_accessKeyId=xxx\n    export node_pre_gyp_secretAccessKey=xxx\n\nYou may also need to specify the `region` if it is not explicit in the `host` value you use. The `bucket` can also be specified but it is optional because `node-pre-gyp` will detect it from the `host` value.\n\n#### 4) Package and publish your build\n\nInstall the `aws-sdk`:\n\n    npm install aws-sdk\n\nThen publish:\n\n    node-pre-gyp package publish\n\nNote: if you hit an error like `Hostname/IP doesn't match certificate's altnames` it may mean that you need to provide the `region` option in your config.\n\n## Appveyor Automation\n\n[Appveyor](http://www.appveyor.com/) can build binaries and publish the results per commit and supports:\n\n - Windows Visual Studio 2013 and related compilers\n - Both 64 bit (x64) and 32 bit (x86) build configurations\n - Multiple Node.js versions\n\nFor an example of doing this see [node-sqlite3's appveyor.yml](https://github.com/mapbox/node-sqlite3/blob/master/appveyor.yml).\n\nBelow is a guide to getting set up:\n\n#### 1) Create a free Appveyor account\n\nGo to https://ci.appveyor.com/signup/free and sign in with your GitHub account.\n\n#### 2) Create a new project\n\nGo to https://ci.appveyor.com/projects/new and select the GitHub repo for your module\n\n#### 3) Add appveyor.yml and push it\n\nOnce you have committed an `appveyor.yml` ([appveyor.yml reference](http://www.appveyor.com/docs/appveyor-yml)) to your GitHub repo and pushed it AppVeyor should automatically start building your project.\n\n#### 4) Create secure variables\n\nEncrypt your S3 AWS keys by going to <https://ci.appveyor.com/tools/encrypt> and hitting the `encrypt` button.\n\nThen paste the result into your `appveyor.yml`\n\n```yml\nenvironment:\n  node_pre_gyp_accessKeyId:\n    secure: Dn9HKdLNYvDgPdQOzRq/DqZ/MPhjknRHB1o+/lVU8MA=\n  node_pre_gyp_secretAccessKey:\n    secure: W1rwNoSnOku1r+28gnoufO8UA8iWADmL1LiiwH9IOkIVhDTNGdGPJqAlLjNqwLnL\n```\n\nNOTE: keys are per account but not per repo (this is difference than Travis where keys are per repo but not related to the account used to encrypt them).\n\n#### 5) Hook up publishing\n\nJust put `node-pre-gyp package publish` in your `appveyor.yml` after `npm install`.\n\n#### 6) Publish when you want\n\nYou might wish to publish binaries only on a specific commit. To do this you could borrow from the [Travis CI idea of commit keywords](http://about.travis-ci.org/docs/user/how-to-skip-a-build/) and add special handling for commit messages with `[publish binary]`:\n\n    SET CM=%APPVEYOR_REPO_COMMIT_MESSAGE%\n    if not \"%CM%\" == \"%CM:[publish binary]=%\" node-pre-gyp --msvs_version=2013 publish\n\nIf your commit message contains special characters (e.g. `&`) this method might fail. An alternative is to use PowerShell, which gives you additional possibilities, like ignoring case by using `ToLower()`:\n\n    ps: if($env:APPVEYOR_REPO_COMMIT_MESSAGE.ToLower().Contains('[publish binary]')) { node-pre-gyp --msvs_version=2013 publish }\n\nRemember this publishing is not the same as `npm publish`. We're just talking about the binary module here and not your entire npm package.\n\n## Travis Automation\n\n[Travis](https://travis-ci.org/) can push to S3 after a successful build and supports both:\n\n - Ubuntu Precise and OS X (64 bit)\n - Multiple Node.js versions\n\nFor an example of doing this see [node-add-example's .travis.yml](https://github.com/springmeyer/node-addon-example/blob/2ff60a8ded7f042864ad21db00c3a5a06cf47075/.travis.yml).\n\nNote: if you need 32 bit binaries, this can be done from a 64 bit Travis machine. See [the node-sqlite3 scripts for an example of doing this](https://github.com/mapbox/node-sqlite3/blob/bae122aa6a2b8a45f6b717fab24e207740e32b5d/scripts/build_against_node.sh#L54-L74).\n\nBelow is a guide to getting set up:\n\n#### 1) Install the Travis gem\n\n    gem install travis\n\n#### 2) Create secure variables\n\nMake sure you run this command from within the directory of your module.\n\nUse `travis-encrypt` like:\n\n    travis encrypt node_pre_gyp_accessKeyId=${node_pre_gyp_accessKeyId}\n    travis encrypt node_pre_gyp_secretAccessKey=${node_pre_gyp_secretAccessKey}\n\nThen put those values in your `.travis.yml` like:\n\n```yaml\nenv:\n  global:\n    - secure: F+sEL/v56CzHqmCSSES4pEyC9NeQlkoR0Gs/ZuZxX1ytrj8SKtp3MKqBj7zhIclSdXBz4Ev966Da5ctmcTd410p0b240MV6BVOkLUtkjZJyErMBOkeb8n8yVfSoeMx8RiIhBmIvEn+rlQq+bSFis61/JkE9rxsjkGRZi14hHr4M=\n    - secure: o2nkUQIiABD139XS6L8pxq3XO5gch27hvm/gOdV+dzNKc/s2KomVPWcOyXNxtJGhtecAkABzaW8KHDDi5QL1kNEFx6BxFVMLO8rjFPsMVaBG9Ks6JiDQkkmrGNcnVdxI/6EKTLHTH5WLsz8+J7caDBzvKbEfTux5EamEhxIWgrI=\n```\n\nMore details on Travis encryption at http://about.travis-ci.org/docs/user/encryption-keys/.\n\n#### 3) Hook up publishing\n\nJust put `node-pre-gyp package publish` in your `.travis.yml` after `npm install`.\n\n##### OS X publishing\n\nIf you want binaries for OS X in addition to linux you can enable [multi-os for Travis](http://docs.travis-ci.com/user/multi-os/#Setting-.travis.yml)\n\nUse a configuration like:\n\n```yml\n\nlanguage: cpp\n\nos:\n- linux\n- osx\n\nenv:\n  matrix:\n    - NODE_VERSION=\"0.10\"\n    - NODE_VERSION=\"0.11.14\"\n\nbefore_install:\n- rm -rf ~/.nvm/ && git clone --depth 1 https://github.com/creationix/nvm.git ~/.nvm\n- source ~/.nvm/nvm.sh\n- nvm install $NODE_VERSION\n- nvm use $NODE_VERSION\n```\n\nSee [Travis OS X Gotchas](#travis-os-x-gotchas) for why we replace `language: node_js` and `node_js:` sections with `language: cpp` and a custom matrix.\n\nAlso create platform specific sections for any deps that need install. For example if you need libpng:\n\n```yml\n- if [ $(uname -s) == 'Linux' ]; then apt-get install libpng-dev; fi;\n- if [ $(uname -s) == 'Darwin' ]; then brew install libpng; fi;\n```\n\nFor detailed multi-OS examples see [node-mapnik](https://github.com/mapnik/node-mapnik/blob/master/.travis.yml) and [node-sqlite3](https://github.com/mapbox/node-sqlite3/blob/master/.travis.yml).\n\n##### Travis OS X Gotchas\n\nFirst, unlike the Travis Linux machines, the OS X machines do not put `node-pre-gyp` on PATH by default. To do so you will need to:\n\n```sh\nexport PATH=$(pwd)/node_modules/.bin:${PATH}\n```\n\nSecond, the OS X machines do not support using a matrix for installing different Node.js versions. So you need to bootstrap the installation of Node.js in a cross platform way.\n\nBy doing:\n\n```yml\nenv:\n  matrix:\n    - NODE_VERSION=\"0.10\"\n    - NODE_VERSION=\"0.11.14\"\n\nbefore_install:\n - rm -rf ~/.nvm/ && git clone --depth 1 https://github.com/creationix/nvm.git ~/.nvm\n - source ~/.nvm/nvm.sh\n - nvm install $NODE_VERSION\n - nvm use $NODE_VERSION\n```\n\nYou can easily recreate the previous behavior of this matrix:\n\n```yml\nnode_js:\n  - \"0.10\"\n  - \"0.11.14\"\n```\n\n#### 4) Publish when you want\n\nYou might wish to publish binaries only on a specific commit. To do this you could borrow from the [Travis CI idea of commit keywords](http://about.travis-ci.org/docs/user/how-to-skip-a-build/) and add special handling for commit messages with `[publish binary]`:\n\n    COMMIT_MESSAGE=$(git log --format=%B --no-merges -n 1 | tr -d '\\n')\n    if [[ ${COMMIT_MESSAGE} =~ \"[publish binary]\" ]]; then node-pre-gyp publish; fi;\n\nThen you can trigger new binaries to be built like:\n\n    git commit -a -m \"[publish binary]\"\n\nOr, if you don't have any changes to make simply run:\n\n    git commit --allow-empty -m \"[publish binary]\"\n\nWARNING: if you are working in a pull request and publishing binaries from there then you will want to avoid double publishing when Travis CI builds both the `push` and `pr`. You only want to run the publish on the `push` commit. See https://github.com/Project-OSRM/node-osrm/blob/8eb837abe2e2e30e595093d16e5354bc5c573575/scripts/is_pr_merge.sh which is called from https://github.com/Project-OSRM/node-osrm/blob/8eb837abe2e2e30e595093d16e5354bc5c573575/scripts/publish.sh for an example of how to do this.\n\nRemember this publishing is not the same as `npm publish`. We're just talking about the binary module here and not your entire npm package. To automate the publishing of your entire package to npm on Travis see http://about.travis-ci.org/docs/user/deployment/npm/\n\n# Versioning\n\nThe `binary` properties of `module_path`, `remote_path`, and `package_name` support variable substitution. The strings are evaluated by `node-pre-gyp` depending on your system and any custom build flags you passed.\n\n - `node_abi`: The node C++ `ABI` number. This value is available in Javascript as `process.versions.modules` as of [`>= v0.10.4 >= v0.11.7`](https://github.com/joyent/node/commit/ccabd4a6fa8a6eb79d29bc3bbe9fe2b6531c2d8e) and in C++ as the `NODE_MODULE_VERSION` define much earlier. For versions of Node before this was available we fallback to the V8 major and minor version.\n - `platform` matches node's `process.platform` like `linux`, `darwin`, and `win32` unless the user passed the `--target_platform` option to override.\n - `arch` matches node's `process.arch` like `x64` or `ia32` unless the user passes the `--target_arch` option to override.\n - `configuration` - Either 'Release' or 'Debug' depending on if `--debug` is passed during the build.\n - `module_name` - the `binary.module_name` attribute from `package.json`.\n - `version` - the semver `version` value for your module from `package.json` (NOTE: ignores the `semver.build` property).\n - `major`, `minor`, `patch`, and `prelease` match the individual semver values for your module's `version`\n - `build` - the sevmer `build` value. For example it would be `this.that` if your package.json `version` was `v1.0.0+this.that`\n - `prerelease` - the semver `prerelease` value. For example it would be `alpha.beta` if your package.json `version` was `v1.0.0-alpha.beta`\n\n\nThe options are visible in the code at <https://github.com/mapbox/node-pre-gyp/blob/612b7bca2604508d881e1187614870ba19a7f0c5/lib/util/versioning.js#L114-L127>\n\n# Download binary files from a mirror\n\nS3 is broken in China for the well known reason.\n\nUsing the `npm` config argument: `--{module_name}_binary_host_mirror` can download binary files through a mirror.\n\ne.g.: Install [v8-profiler](https://www.npmjs.com/package/v8-profiler) from `npm`.\n\n```bash\n$ npm install v8-profiler --profiler_binary_host_mirror=https://npm.taobao.org/mirrors/node-inspector/\n```\n",
  "readmeFilename": "README.md",
  "repository": {
    "type": "git",
    "url": "git://github.com/mapbox/node-pre-gyp.git"
  },
  "scripts": {
    "prepublish": "retire -n && npm ls && jshint test/build.test.js test/s3_setup.test.js test/versioning.test.js",
    "test": "jshint lib lib/util scripts bin/node-pre-gyp && mocha -R spec --timeout 500000",
    "update-crosswalk": "node scripts/abi_crosswalk.js"
  },
  "version": "0.6.31"
}

},{}],86:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = _dereq_('events').EventEmitter;
var inherits = _dereq_('inherits');

inherits(Stream, EE);
Stream.Readable = _dereq_('readable-stream/readable.js');
Stream.Writable = _dereq_('readable-stream/writable.js');
Stream.Duplex = _dereq_('readable-stream/duplex.js');
Stream.Transform = _dereq_('readable-stream/transform.js');
Stream.PassThrough = _dereq_('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":11,"inherits":14,"readable-stream/duplex.js":88,"readable-stream/passthrough.js":95,"readable-stream/readable.js":96,"readable-stream/transform.js":97,"readable-stream/writable.js":98}],87:[function(_dereq_,module,exports){
arguments[4][9][0].apply(exports,arguments)
},{"dup":9}],88:[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_duplex.js")

},{"./lib/_stream_duplex.js":89}],89:[function(_dereq_,module,exports){
arguments[4][36][0].apply(exports,arguments)
},{"./_stream_readable":91,"./_stream_writable":93,"core-util-is":10,"dup":36,"inherits":14,"process-nextick-args":19}],90:[function(_dereq_,module,exports){
arguments[4][37][0].apply(exports,arguments)
},{"./_stream_transform":92,"core-util-is":10,"dup":37,"inherits":14}],91:[function(_dereq_,module,exports){
(function (process){
'use strict';

module.exports = Readable;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var isArray = _dereq_('isarray');
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Readable.ReadableState = ReadableState;

/*<replacement>*/
var EE = _dereq_('events').EventEmitter;

var EElistenerCount = function (emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

/*<replacement>*/
var Stream;
(function () {
  try {
    Stream = _dereq_('st' + 'ream');
  } catch (_) {} finally {
    if (!Stream) Stream = _dereq_('events').EventEmitter;
  }
})();
/*</replacement>*/

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

/*<replacement>*/
var debugUtil = _dereq_('util');
var debug = void 0;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var BufferList = _dereq_('./internal/streams/BufferList');
var StringDecoder;

util.inherits(Readable, Stream);

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function') {
    return emitter.prependListener(event, fn);
  } else {
    // This is a hack to make sure that our error handler is attached before any
    // userland ones.  NEVER DO THIS. This is here only because this code needs
    // to continue to work with older versions of Node.js that do not include
    // the prependListener() method. The goal is to eventually remove this hack.
    if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);else if (isArray(emitter._events[event])) emitter._events[event].unshift(fn);else emitter._events[event] = [fn, emitter._events[event]];
  }
}

function ReadableState(options, stream) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  options = options || {};

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex) this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~ ~this.highWaterMark;

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()
  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // when piping, we only care about 'readable' events that happen
  // after read()ing all the bytes and not getting any pushback.
  this.ranOut = false;

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder) StringDecoder = _dereq_('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  if (!(this instanceof Readable)) return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options && typeof options.read === 'function') this._read = options.read;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  var state = this._readableState;

  if (!state.objectMode && typeof chunk === 'string') {
    encoding = encoding || state.defaultEncoding;
    if (encoding !== state.encoding) {
      chunk = bufferShim.from(chunk, encoding);
      encoding = '';
    }
  }

  return readableAddChunk(this, state, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function (chunk) {
  var state = this._readableState;
  return readableAddChunk(this, state, chunk, '', true);
};

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || chunk && chunk.length > 0) {
    if (state.ended && !addToFront) {
      var e = new Error('stream.push() after EOF');
      stream.emit('error', e);
    } else if (state.endEmitted && addToFront) {
      var _e = new Error('stream.unshift() after end event');
      stream.emit('error', _e);
    } else {
      var skipAdd;
      if (state.decoder && !addToFront && !encoding) {
        chunk = state.decoder.write(chunk);
        skipAdd = !state.objectMode && chunk.length === 0;
      }

      if (!addToFront) state.reading = false;

      // Don't add to the buffer if we've decoded to an empty string chunk and
      // we're not in object mode
      if (!skipAdd) {
        // if we want the data now, just emit it.
        if (state.flowing && state.length === 0 && !state.sync) {
          stream.emit('data', chunk);
          stream.read(0);
        } else {
          // update the buffer info.
          state.length += state.objectMode ? 1 : chunk.length;
          if (addToFront) state.buffer.unshift(chunk);else state.buffer.push(chunk);

          if (state.needReadable) emitReadable(stream);
        }
      }

      maybeReadMore(stream, state);
    }
  } else if (!addToFront) {
    state.reading = false;
  }

  return needMoreData(state);
}

// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
}

// backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = _dereq_('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || state.length === 0 && state.ended) return 0;
  if (state.objectMode) return 1;
  if (n !== n) {
    // Only flow one buffer at a time
    if (state.flowing && state.length) return state.buffer.head.data.length;else return state.length;
  }
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n <= state.length) return n;
  // Don't have enough
  if (!state.ended) {
    state.needReadable = true;
    return 0;
  }
  return state.length;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  debug('read', n);
  n = parseInt(n, 10);
  var state = this._readableState;
  var nOrig = n;

  if (n !== 0) state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) endReadable(this);else emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0) ret = fromList(n, state);else ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  } else {
    state.length -= n;
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }

  if (ret !== null) this.emit('data', ret);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== null && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync) processNextTick(emitReadable_, stream);else emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}

// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    processNextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;else len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (n) {
  this.emit('error', new Error('_read() is not implemented'));
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted) processNextTick(endFn);else src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    debug('onunpipe');
    if (readable === src) {
      cleanup();
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain)) ondrain();
  }

  // If the user pushes more data while we're writing to dest then we'll end up
  // in ondata again. However, we only want to increase awaitDrain once because
  // dest will only emit one 'drain' event for the multiple writes.
  // => Introduce a guard on increasing awaitDrain.
  var increasedAwaitDrain = false;
  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    increasedAwaitDrain = false;
    var ret = dest.write(chunk);
    if (false === ret && !increasedAwaitDrain) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
        increasedAwaitDrain = true;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0) dest.emit('error', er);
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function () {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain) state.awaitDrain--;
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0) return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes) return this;

    if (!dest) dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest) dest.emit('unpipe', this);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++) {
      dests[i].emit('unpipe', this);
    }return this;
  }

  // try to find the right one.
  var index = indexOf(state.pipes, dest);
  if (index === -1) return this;

  state.pipes.splice(index, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1) state.pipes = state.pipes[0];

  dest.emit('unpipe', this);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function (ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  if (ev === 'data') {
    // Start flowing on next tick if stream isn't explicitly paused
    if (this._readableState.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    var state = this._readableState;
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.emittedReadable = false;
      if (!state.reading) {
        processNextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function () {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    processNextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  state.awaitDrain = 0;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  while (state.flowing && stream.read() !== null) {}
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function () {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function (chunk) {
    debug('wrapped data');
    if (state.decoder) chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined)) return;else if (!state.objectMode && (!chunk || !chunk.length)) return;

    var ret = self.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function (method) {
        return function () {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  }

  // proxy certain important events.
  var events = ['error', 'close', 'destroy', 'pause', 'resume'];
  forEach(events, function (ev) {
    stream.on(ev, self.emit.bind(self, ev));
  });

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  self._read = function (n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return self;
};

// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered
  if (state.length === 0) return null;

  var ret;
  if (state.objectMode) ret = state.buffer.shift();else if (!n || n >= state.length) {
    // read it all, truncate the list
    if (state.decoder) ret = state.buffer.join('');else if (state.buffer.length === 1) ret = state.buffer.head.data;else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = fromListPartial(n, state.buffer, state.decoder);
  }

  return ret;
}

// Extracts only enough buffered data to satisfy the amount requested.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromListPartial(n, list, hasStrings) {
  var ret;
  if (n < list.head.data.length) {
    // slice is the same for buffers and strings
    ret = list.head.data.slice(0, n);
    list.head.data = list.head.data.slice(n);
  } else if (n === list.head.data.length) {
    // first chunk is a perfect match
    ret = list.shift();
  } else {
    // result spans more than one buffer
    ret = hasStrings ? copyFromBufferString(n, list) : copyFromBuffer(n, list);
  }
  return ret;
}

// Copies a specified amount of characters from the list of buffered data
// chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBufferString(n, list) {
  var p = list.head;
  var c = 1;
  var ret = p.data;
  n -= ret.length;
  while (p = p.next) {
    var str = p.data;
    var nb = n > str.length ? str.length : n;
    if (nb === str.length) ret += str;else ret += str.slice(0, n);
    n -= nb;
    if (n === 0) {
      if (nb === str.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = str.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

// Copies a specified amount of bytes from the list of buffered data chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBuffer(n, list) {
  var ret = bufferShim.allocUnsafe(n);
  var p = list.head;
  var c = 1;
  p.data.copy(ret);
  n -= p.data.length;
  while (p = p.next) {
    var buf = p.data;
    var nb = n > buf.length ? buf.length : n;
    buf.copy(ret, ret.length - n, 0, nb);
    n -= nb;
    if (n === 0) {
      if (nb === buf.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = buf.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0) throw new Error('"endReadable()" called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    processNextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function forEach(xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

function indexOf(xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}
}).call(this,_dereq_('_process'))
},{"./_stream_duplex":89,"./internal/streams/BufferList":94,"_process":20,"buffer":8,"buffer-shims":7,"core-util-is":10,"events":11,"inherits":14,"isarray":87,"process-nextick-args":19,"string_decoder/":99,"util":5}],92:[function(_dereq_,module,exports){
// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = _dereq_('./_stream_duplex');

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);

function TransformState(stream) {
  this.afterTransform = function (er, data) {
    return afterTransform(stream, er, data);
  };

  this.needTransform = false;
  this.transforming = false;
  this.writecb = null;
  this.writechunk = null;
  this.writeencoding = null;
}

function afterTransform(stream, er, data) {
  var ts = stream._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb) return stream.emit('error', new Error('no writecb in Transform class'));

  ts.writechunk = null;
  ts.writecb = null;

  if (data !== null && data !== undefined) stream.push(data);

  cb(er);

  var rs = stream._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    stream._read(rs.highWaterMark);
  }
}

function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);

  Duplex.call(this, options);

  this._transformState = new TransformState(this);

  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;

    if (typeof options.flush === 'function') this._flush = options.flush;
  }

  // When the writable side finishes, then flush out anything remaining.
  this.once('prefinish', function () {
    if (typeof this._flush === 'function') this._flush(function (er, data) {
      done(stream, er, data);
    });else done(stream);
  });
}

Transform.prototype.push = function (chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function (chunk, encoding, cb) {
  throw new Error('_transform() is not implemented');
};

Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark) this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function (n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};

function done(stream, er, data) {
  if (er) return stream.emit('error', er);

  if (data !== null && data !== undefined) stream.push(data);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  var ws = stream._writableState;
  var ts = stream._transformState;

  if (ws.length) throw new Error('Calling transform done when ws.length != 0');

  if (ts.transforming) throw new Error('Calling transform done when still transforming');

  return stream.push(null);
}
},{"./_stream_duplex":89,"core-util-is":10,"inherits":14}],93:[function(_dereq_,module,exports){
(function (process){
// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

module.exports = Writable;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var asyncWrite = !process.browser && ['v0.10', 'v0.9.'].indexOf(process.version.slice(0, 5)) > -1 ? setImmediate : processNextTick;
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Writable.WritableState = WritableState;

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

/*<replacement>*/
var internalUtil = {
  deprecate: _dereq_('util-deprecate')
};
/*</replacement>*/

/*<replacement>*/
var Stream;
(function () {
  try {
    Stream = _dereq_('st' + 'ream');
  } catch (_) {} finally {
    if (!Stream) Stream = _dereq_('events').EventEmitter;
  }
})();
/*</replacement>*/

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

util.inherits(Writable, Stream);

function nop() {}

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

function WritableState(options, stream) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  options = options || {};

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex) this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~ ~this.highWaterMark;

  // drain event flag.
  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function (er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;

  // count buffered requests
  this.bufferedRequestCount = 0;

  // allocate the first CorkedRequest, there is always
  // one allocated and free to use, and we maintain at most two
  this.corkedRequestsFree = new CorkedRequest(this);
}

WritableState.prototype.getBuffer = function getBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function () {
  try {
    Object.defineProperty(WritableState.prototype, 'buffer', {
      get: internalUtil.deprecate(function () {
        return this.getBuffer();
      }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.')
    });
  } catch (_) {}
})();

// Test _writableState for inheritance to account for Duplex streams,
// whose prototype chain only points to Readable.
var realHasInstance;
if (typeof Symbol === 'function' && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === 'function') {
  realHasInstance = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function (object) {
      if (realHasInstance.call(this, object)) return true;

      return object && object._writableState instanceof WritableState;
    }
  });
} else {
  realHasInstance = function (object) {
    return object instanceof this;
  };
}

function Writable(options) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  // Writable ctor is applied to Duplexes, too.
  // `realHasInstance` is necessary because using plain `instanceof`
  // would return false, as no `_writableState` property is attached.

  // Trying to use the custom `instanceof` for Writable here will also break the
  // Node.js LazyTransform implementation, which has a non-trivial getter for
  // `_writableState` that would lead to infinite recursion.
  if (!realHasInstance.call(Writable, this) && !(this instanceof Duplex)) {
    return new Writable(options);
  }

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function') this._write = options.write;

    if (typeof options.writev === 'function') this._writev = options.writev;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function () {
  this.emit('error', new Error('Cannot pipe, not readable'));
};

function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  processNextTick(cb, er);
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  var er = false;
  // Always throw error if a null is written
  // if we are not in object mode then throw
  // if it is not a buffer, string, or undefined.
  if (chunk === null) {
    er = new TypeError('May not write null values to stream');
  } else if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  if (er) {
    stream.emit('error', er);
    processNextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function (chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (Buffer.isBuffer(chunk)) encoding = 'buffer';else if (!encoding) encoding = state.defaultEncoding;

  if (typeof cb !== 'function') cb = nop;

  if (state.ended) writeAfterEnd(this, cb);else if (validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function () {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.bufferedRequest) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string') encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1)) throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
    chunk = bufferShim.from(chunk, encoding);
  }
  return chunk;
}

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, chunk, encoding, cb) {
  chunk = decodeChunk(state, chunk, encoding);

  if (Buffer.isBuffer(chunk)) encoding = 'buffer';
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = new WriteReq(chunk, encoding, cb);
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
    state.bufferedRequestCount += 1;
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev) stream._writev(chunk, state.onwrite);else stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;
  if (sync) processNextTick(cb, er);else cb(er);

  stream._writableState.errorEmitted = true;
  stream.emit('error', er);
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er) onwriteError(stream, state, sync, er, cb);else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      /*<replacement>*/
      asyncWrite(afterWrite, stream, state, finished, cb);
      /*</replacement>*/
    } else {
        afterWrite(stream, state, finished, cb);
      }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished) onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}

// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var l = state.bufferedRequestCount;
    var buffer = new Array(l);
    var holder = state.corkedRequestsFree;
    holder.entry = entry;

    var count = 0;
    while (entry) {
      buffer[count] = entry;
      entry = entry.next;
      count += 1;
    }

    doWrite(stream, state, true, state.length, buffer, '', holder.finish);

    // doWrite is almost always async, defer these to save a bit of time
    // as the hot path ends with doWrite
    state.pendingcb++;
    state.lastBufferedRequest = null;
    if (holder.next) {
      state.corkedRequestsFree = holder.next;
      holder.next = null;
    } else {
      state.corkedRequestsFree = new CorkedRequest(state);
    }
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null) state.lastBufferedRequest = null;
  }

  state.bufferedRequestCount = 0;
  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new Error('_write() is not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function (chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished) endWritable(this, state, cb);
};

function needFinish(state) {
  return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
}

function prefinish(stream, state) {
  if (!state.prefinished) {
    state.prefinished = true;
    stream.emit('prefinish');
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    if (state.pendingcb === 0) {
      prefinish(stream, state);
      state.finished = true;
      stream.emit('finish');
    } else {
      prefinish(stream, state);
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished) processNextTick(cb);else stream.once('finish', cb);
  }
  state.ended = true;
  stream.writable = false;
}

// It seems a linked list but it is not
// there will be only 2 of these for each stream
function CorkedRequest(state) {
  var _this = this;

  this.next = null;
  this.entry = null;

  this.finish = function (err) {
    var entry = _this.entry;
    _this.entry = null;
    while (entry) {
      var cb = entry.callback;
      state.pendingcb--;
      cb(err);
      entry = entry.next;
    }
    if (state.corkedRequestsFree) {
      state.corkedRequestsFree.next = _this;
    } else {
      state.corkedRequestsFree = _this;
    }
  };
}
}).call(this,_dereq_('_process'))
},{"./_stream_duplex":89,"_process":20,"buffer":8,"buffer-shims":7,"core-util-is":10,"events":11,"inherits":14,"process-nextick-args":19,"util-deprecate":102}],94:[function(_dereq_,module,exports){
arguments[4][41][0].apply(exports,arguments)
},{"buffer":8,"buffer-shims":7,"dup":41}],95:[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_passthrough.js")

},{"./lib/_stream_passthrough.js":90}],96:[function(_dereq_,module,exports){
arguments[4][49][0].apply(exports,arguments)
},{"./lib/_stream_duplex.js":89,"./lib/_stream_passthrough.js":90,"./lib/_stream_readable.js":91,"./lib/_stream_transform.js":92,"./lib/_stream_writable.js":93,"_process":20,"dup":49}],97:[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_transform.js")

},{"./lib/_stream_transform.js":92}],98:[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_writable.js")

},{"./lib/_stream_writable.js":93}],99:[function(_dereq_,module,exports){
arguments[4][47][0].apply(exports,arguments)
},{"buffer":8,"dup":47}],100:[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var punycode = _dereq_('punycode');
var util = _dereq_('./util');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // Special case for a simple path URL
    simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = _dereq_('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && util.isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!util.isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  var queryIndex = url.indexOf('?'),
      splitter =
          (queryIndex !== -1 && queryIndex < url.indexOf('#')) ? '?' : '#',
      uSplit = url.split(splitter),
      slashRegex = /\\/g;
  uSplit[0] = uSplit[0].replace(slashRegex, '/');
  url = uSplit.join(splitter);

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  if (!slashesDenoteHost && url.split('#').length === 1) {
    // Try fast path regexp
    var simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.substr(1));
        } else {
          this.query = this.search.substr(1);
        }
      } else if (parseQueryString) {
        this.search = '';
        this.query = {};
      }
      return this;
    }
  }

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a punycoded representation of "domain".
      // It only converts parts of the domain name that
      // have non-ASCII characters, i.e. it doesn't matter if
      // you call it with a domain that already is ASCII-only.
      this.hostname = punycode.toASCII(this.hostname);
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      if (rest.indexOf(ae) === -1)
        continue;
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (util.isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      util.isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (util.isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  var tkeys = Object.keys(this);
  for (var tk = 0; tk < tkeys.length; tk++) {
    var tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    var rkeys = Object.keys(relative);
    for (var rk = 0; rk < rkeys.length; rk++) {
      var rkey = rkeys[rk];
      if (rkey !== 'protocol')
        result[rkey] = relative[rkey];
    }

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      var keys = Object.keys(relative);
      for (var v = 0; v < keys.length; v++) {
        var k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!util.isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especially happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host || srcPath.length > 1) &&
      (last === '.' || last === '..') || last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especially happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

},{"./util":101,"punycode":21,"querystring":24}],101:[function(_dereq_,module,exports){
'use strict';

module.exports = {
  isString: function(arg) {
    return typeof(arg) === 'string';
  },
  isObject: function(arg) {
    return typeof(arg) === 'object' && arg !== null;
  },
  isNull: function(arg) {
    return arg === null;
  },
  isNullOrUndefined: function(arg) {
    return arg == null;
  }
};

},{}],102:[function(_dereq_,module,exports){
arguments[4][48][0].apply(exports,arguments)
},{"dup":48}],103:[function(_dereq_,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],104:[function(_dereq_,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = _dereq_('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = _dereq_('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,_dereq_('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":103,"_process":20,"inherits":14}],105:[function(_dereq_,module,exports){
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

},{}],106:[function(_dereq_,module,exports){
var sqlite3 = _dereq_('sqlite3').verbose();

exports.open = function (name) {
    return new sqlite3.Database(name);
};

},{"sqlite3":25}],107:[function(_dereq_,module,exports){
function query(obj, tableName) {
    var args = [];
    var str = parseObject(obj, tableName, args);
    return {query: str, args: args};
}

function parseObject(obj, tableName, args) {
    var result = [];
    for (var key in obj)
        if (obj.hasOwnProperty(key)) {
            var val = obj[key];
            if (['$or', '$and'].indexOf(key) > -1 && !Array.isArray(val))
                throw new Error("Use of $and, $or operator requires an array as its parameter.");
            result.length && result.push(' AND ');
            switch (key) {
                case '$or':
                    var s = val.map(function (item) {
                        return parseObject(item, tableName, args);
                    });
                    if (s.length)
                        result.push('(' + s.join(' OR ') + ')');
                    break;
                case '$and':
                    s = val.map(function (item) {
                        return parseObject(item, tableName, args);
                    });
                    if (s.length)
                        result.push('(' + s.join(') AND (') + ')');
                    break;
                default:
                    result.push(parseSingleKeyValue(key, val, tableName, args));
                    break;
            }
        }
    return result.join('');
}

function parseSingleKeyValue(key, val, tableName, args) {
    var result = '';
    switch (key) {
        case '$lt':
            result = result + ' < ?';
            args.push(val + '');
            break;
        case '$gt':
            result = result + ' > ?';
            args.push(val + '');
            break;
        case '$lte':
            result = result + ' <= ?';
            args.push(val + '');
            break;
        case '$gte':
            result = result + ' >= ?';
            args.push(val + '');
            break;
        case '$ne':
            result = result + ' != ?';
            args.push(val + '');
            break;
        case '$in':
            result = result + ' IN [' + val.map(function () {
                    return '?'
                }).join() + ']';
            args.push(val.map(function (v) {
                return v + '' || null;
            }).join());
            break;
        case '$nin':
            result = result + ' NOT IN [' + val.map(function () {
                    return '?'
                }).join() + ']';
            args.push(val.map(function (v) {
                return v + '' || null;
            }).join());
            break;
        case '$like':
            result = result + ' LIKE ?';
            args.push(val + '');
            break;
        default:
            result = result + '`' + tableName + '`.`' + key + '`'+ (typeof val === 'object' ? parseObject(val, tableName, args) : ' = ?');
            typeof val !== 'object' && args.push(val + '');
            break;
    }
    return result;
}

exports.query = query;
},{}],108:[function(_dereq_,module,exports){
'use strict';

var vuvuzela = _dereq_('vuvuzela');

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
},{"vuvuzela":105}]},{},[2]);