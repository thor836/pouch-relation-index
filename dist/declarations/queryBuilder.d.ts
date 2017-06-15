export default class QueryBuilder {
    private static readonly operators;
    static query(selector: any, table: any): {
        where: string;
        args: any[];
    };
    private static parseObject(obj, tableName, args);
    private static parseSingleKeyValue(key, val, tableName, args);
}
