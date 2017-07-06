import WebSqlProvider from "./webSqlProvider";

export default class SqliteProvider extends WebSqlProvider {

    batchSql(batch: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            let conn = this.openConnection();
            if (typeof conn.sqlBatch === 'function') {
                conn.sqlBatch(batch, resolve, reject);
            } else {
                super.batchSql(batch).then(resolve).catch(reject);
            }
        });
    }

    protected openConnection() {
        return window['sqlitePlugin'].openDatabase({
            name: this.db,
            location: 'default',
            androidDatabaseImplementation: 2,
            version: 1,
            description: this.db,
            size: 5000000
        });
    }
}
