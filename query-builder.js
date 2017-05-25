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
        case '$eq':
            result = result + ' == ?';
            args.push(val + '');
            break;
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