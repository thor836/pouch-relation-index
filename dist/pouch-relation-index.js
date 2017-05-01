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


/**
 * Create index table
 * @param name Index name
 * @param type Documents type
 * @param fields Indexed fields
 */
function createIndex(name, type, fields) {
    var db = utils.openDB(this._name);
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
    var db = utils.openDB(this._name);
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

    var db = utils.openDB(this._name);
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

    var db = utils.openDB(this._name);
    return Promise.all([
        executeSql(db, 'DELETE FROM \'relation-indexes\' WHERE index_name = ?', [name]),
        executeSql(db, 'DROP TABLE IF EXISTS `_ri_'+ name +'`')]);
}

/**
 * Fast refresh index. Adds a new documents to index table
 * @param name Index name
 */
function refreshIndex(name) {
    var c = checkCompatibility(this);
    if (c)
        return Promise.reject(c);
    var db = utils.openDB(this._name);

    return getIndexInfo(db, name)
        .then(function (indexInfo) {
            var sql = 'SELECT `by-sequence`.seq AS seq, `by-sequence`.deleted AS deleted, `by-sequence`.json AS data, `by-sequence`.rev AS rev, `document-store`.id AS id, `document-store`.json AS metadata \nFROM `document-store` \nJOIN `by-sequence` ON `by-sequence`.seq = `document-store`.winningseq \nWHERE NOT EXISTS(SELECT 1 FROM `_ri_' + name + '` WHERE `document-store`.id = `_ri_' + name + '`.id ) AND`by-sequence`.deleted = 0';
            return executeSql(db, sql)
                .then(function (res) {
                    var docs = [];
                    for (var i = 0; i < res.rows.length; i++) {
                        var row = res.rows.item(i);
                        var doc = utils.unstringifyDoc(row.data, row.id, row.rev);
                        doc.type === indexInfo.doc_type && docs.push(doc);
                    }
                    if (!docs.length)
                        return;

                    var tb = utils.wrapTableName('_ri_' + indexInfo.index_name);
                    var fields = utils.getFields(['_id', '_rev'].concat(indexInfo.fields));
                    var sqlStatements = docs.map(function (doc) {
                        var p = Array(fields.length).fill('?');
                        var args = fields.map(function (f) {
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
                var p = Array(fields.length).fill('?');
                var args = fields.map(function (f) {
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


exports.createIndex = createIndex;
exports.buildIndex = buildIndex;
exports.queryIndex = queryIndex;
exports.deleteIndex = deleteIndex;
exports.refreshIndex = refreshIndex;

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
    window.PouchDB.plugin(exports);
}

},{"./query-builder.js":5,"./utils":6,"lie":3}],2:[function(_dereq_,module,exports){
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
},{}],3:[function(_dereq_,module,exports){
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

},{"immediate":2}],4:[function(_dereq_,module,exports){
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

},{}],5:[function(_dereq_,module,exports){
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
},{}],6:[function(_dereq_,module,exports){
'use strict';

var vuvuzela = _dereq_('vuvuzela');

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
},{"vuvuzela":4}]},{},[1]);
