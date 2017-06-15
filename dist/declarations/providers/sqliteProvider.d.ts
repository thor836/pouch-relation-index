import WebSqlProvider from "./webSqlProvider";
export default class SqliteProvider extends WebSqlProvider {
    batchSql(batch: any[]): Promise<any>;
    protected openConnection(): any;
}
