var sqlite3 = require('sqlite3').verbose();

exports.open = function (name) {
    return new sqlite3.Database(name);
};
