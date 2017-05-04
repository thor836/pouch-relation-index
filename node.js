var openDb = require('./open-database-node');
exports = require('./index').init(openDb.open);
