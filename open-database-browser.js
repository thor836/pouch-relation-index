function getSize() {
    var isAndroid = typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent);
    return isAndroid ? 5000000 : 1;
}

/* global cordova, sqlitePlugin, openDatabase */
exports.open = function (name) {
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
