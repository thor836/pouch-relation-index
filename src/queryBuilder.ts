import Utils from "./utils";
import SelectorError from "./errors/selectorError";

export default class QueryBuilder {
    private static readonly operators = {
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

    static query(selector, table) {
        let args = [];
        let str = QueryBuilder.parseObject(selector, table, args);
        return {where: str, args: args};
    }

    private static parseObject(obj, tableName, args) {
        let result = [];
        for (let key in obj)
            if (obj.hasOwnProperty(key)) {
                let val = obj[key];

                if (['$or', '$and'].indexOf(key) > -1 && !Array.isArray(val))
                    throw new SelectorError("Use of $and, $or operator requires an array as its parameter.");

                result.length && result.push(' AND ');
                switch (key) {
                    case '$or':
                        let s = val.map(item => QueryBuilder.parseObject(item, tableName, args));
                        s.length && result.push(`(${s.join(' OR ')})`);
                        break;
                    case '$and':
                        s = val.map(item => QueryBuilder.parseObject(item, tableName, args));
                        s.length && result.push(`(${s.join(' AND ')})`);
                        break;
                    default:
                        result.push(QueryBuilder.parseSingleKeyValue(key, val, tableName, args));
                        break;
                }
            }
        return result.join('');
    }

    private static parseSingleKeyValue(key, val, tableName, args) {
        let op = QueryBuilder.operators[key] || (typeof val !== 'object' ? QueryBuilder.operators['$eq'] : null);
        if (op) {
            let res = `${Utils.wrap(tableName)}.${Utils.wrap(key)} ${op}`;
            if (key == '$in' || key == '$nin') {
                if (!Array.isArray(val))
                    throw new SelectorError("Use of $in, $nin operator requires an array as its parameter.");

                args.concat(val);
                return `${res} [${Array(val.length).fill('?').join()}]`;
            } else {
                args.push(typeof val === 'string' ? val.toLowerCase() : val);
                return `${res} ?`;
            }
        }
        return `${Utils.wrap(tableName)}.${Utils.wrap(key)} ${QueryBuilder.parseObject(val, tableName, args)}`;
    }
}