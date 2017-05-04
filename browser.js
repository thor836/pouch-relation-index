var openDb = require('./open-database-browser');
var relIndex = require('./index').init(openDb.open);

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
    window.PouchDB.plugin(relIndex);
}
