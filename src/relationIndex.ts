import PouchDB from "pouchdb";
import IndexNotFoundError from "./errors/indexNotFoundError";
import Utils from "./utils";
import IndexExistsError from "./errors/indexExistsError";
import {Provider} from "./providers/provider";
import SqliteProvider from "./providers/sqliteProvider";
import WebSqlProvider from "./providers/webSqlProvider";
import QueryBuilder from "./queryBuilder";
import {IndexInfo, Field, Order} from "./types";

const INDEX_TABLE = 'relation-indexes';
const INDEX_PREFIX = '_ri_';

export type QueryOptions = {selector: any, order?: Order[], start?: number, limit?: number, include_docs?: boolean };

export class RelationIndex {

    private _init = false;
    private readonly indexes: { [key: string]: IndexInfo } = {};

    constructor(private readonly db: PouchDB.Database<any>,
                private readonly provider: Provider) {
    }

    info(name: string) {
        let index = this.indexes[name];
        return index ? Promise.resolve(index) : Promise.reject(new IndexNotFoundError(name));
    }

    create(options: IndexInfo) {
        if (this.indexes[options.name])
            return Promise.reject(new IndexExistsError(options.name));
        let fields = options.fields.map(f => {
            return {name: f.name || (f + ''), type: f.type || ''};
        });
        let internalFields = [{name: 'id', primary_key: true},
            {name: 'rev'}]
            .concat(fields);
        return this.createTable(`${INDEX_PREFIX}${options.name}`, internalFields)
            .then(() => this.provider.executeSql(`INSERT INTO ${Utils.wrap(INDEX_TABLE)} VALUES (?,?,?)`, [options.name, options.doc_type, JSON.stringify(fields)]))
            .then(() => {
                this.indexes[options.name] = Object.assign({}, options, {fields});
            });
    }

    build(name: string) {
        let index = this.indexes[name];
        if (!index)
            return Promise.reject(new IndexNotFoundError(name));

        let tbl = Utils.wrap(`${INDEX_PREFIX}${name}`);
        return this.provider.executeSql(`DELETE FROM ${tbl}`)
            .then(() => this.fillIndexTable(index));
    }

    query(name: string, options: QueryOptions) {
        let index = this.indexes[name];
        if (!index)
            return Promise.reject(new IndexNotFoundError(name));

        let tbl = Utils.wrap(`${INDEX_PREFIX}${name}`);
        let q = options.selector ? QueryBuilder.query(options.selector, `${INDEX_PREFIX}${name}`) : null;
        let orderBy = options.order && options.order.length ? options.order.map(o => `${tbl}.${Utils.wrap(o.field || (o + ''))} ${o.dir || 'ASC'}`).join() : '';
        let sql;
        if (options.include_docs != false)
            sql = `
            SELECT
                \`document-store\`.id AS id,
                \`by-sequence\`.rev AS rev,
                \`by-sequence\`.json AS data 
            FROM \`document-store\` 
                JOIN \`by-sequence\` ON \`by-sequence\`.seq = \`document-store\`.winningseq 
                JOIN ${tbl} ON \`document-store\`.id = ${tbl}.id 
            WHERE 
                ${q.where ? q.where + ' AND ' : ''} 
                \`by-sequence\`.deleted = 0 
            ORDER BY ${orderBy ? orderBy + ',' : ''} \`document-store\`.id ASC`;
        else {
            let flds = index.fields.map(f => tbl + Utils.wrap(f.name));
            sql = `SELECT ${flds.join()} FROM ${tbl} WHERE ${q.where ? q.where + ' AND ' : ''} 1 = 1 ${orderBy ? 'ORDER BY ' + orderBy + ',' : ''}`;
        }
        sql = `${sql} ${options.limit ? 'LIMIT ' + options.limit : ''} ${options.start ? 'OFFSET ' + options.start : ''}`;

        return this.provider.executeSql(sql, q.args)
            .then(res => {
                let docs = [];
                for (let i = 0; i < res.rows.length; i++) {
                    let row = res.rows.item(i);
                    docs.push(Utils.unstringifyDoc(row.data, row.id, row.rev));
                }
                return docs;
            });
    }

    remove(name: string) {
        let index = this.indexes[name];
        if (!index)
            return Promise.reject(new IndexNotFoundError(name));

        let tbl = Utils.wrap(`${INDEX_PREFIX}${name}`);
        return this.provider.executeSql(`DELETE FROM ${Utils.wrap(INDEX_TABLE)} WHERE index_name = ?`, [name])
            .then(() => this.provider.executeSql(`DROP TABLE IF EXISTS ${tbl}`))
            .then(() => {
                delete this.indexes[name]
            });
    }

    update(name: string) {
        let index = this.indexes[name];
        if (!index)
            return Promise.reject(new IndexNotFoundError(name));
        let tbl = Utils.wrap(`${INDEX_PREFIX}${name}`);
        let docTypeLen = index.doc_type.length;
        let fields = ['_id', '_rev'].concat(index.fields.map(f => f.name));
        let p = Array(fields.length).fill('?');

        let sql = `
        SELECT 
            \`document-store\`.id AS id, 
            \`by-sequence\`.rev AS rev, 
            \`by-sequence\`.json AS data 
        FROM \`document-store\` 
            JOIN \`by-sequence\` ON \`by-sequence\`.seq = \`document-store\`.winningseq  
        WHERE 
            NOT EXISTS(SELECT 1 FROM ${tbl} WHERE \`document-store\`.id like ${tbl}.id )  
            AND 
            substr(\`document-store\`.id, 1, ${docTypeLen}) = ?  
            AND 
            \`by-sequence\`.deleted = 0`;

        return this.provider.executeSql(sql, [index.doc_type])
            .then(res => {
                let docs = [];
                for (let i = 0; i < res.rows.length; i++) {
                    let row = res.rows.item(i);
                    docs.push(Utils.unstringifyDoc(row.data, row.id, row.rev));
                }
                if (!docs.length)
                    return;

                let sqlStatements = docs.map(function (r) {
                    let args = fields.map(f => {
                        let v = Utils.resolve(r, f);
                        return typeof v === 'string' ? v.toLowerCase() : v;
                    });
                    return [`INSERT INTO ${tbl} VALUES (${p})`, args];
                });
                return this.provider.batchSql(sqlStatements);
            });
    }

    init() {
        if (this._init)
            return Promise.resolve(null);

        return this.createTable(INDEX_TABLE, [
                {name: 'index_name', type: 'TEXT'},
                {name: 'doc_type', type: 'TEXT'},
                {name: 'json', type: 'TEXT'}
            ])
            .then(() => this.getIndexes())
            .then(() => {
                this._init = true
            });
    }

    private getIndexes() {
        return this.provider.executeSql(`SELECT * FROM ${Utils.wrap(INDEX_TABLE)}`)
            .then(rs => {
                for (let i = 0; i < rs.rows.length; i++) {
                    let row = rs.rows.item(i);
                    this.indexes[row.index_name] = {
                        name: row.index_name,
                        doc_type: row.doc_type,
                        fields: JSON.parse(row.json)
                    };
                }
            });
    }

    private createTable(name: string, fields: Field[]) {
        return this.provider.executeSql(`CREATE TABLE IF NOT EXISTS ${Utils.wrap(name)} (${Utils.fieldsToSql(fields)})`)
            .then(() => {
            });
    }

    private fillIndexTable(index: IndexInfo, start: number = 0) {
        let limit = 1000;
        let tbl = Utils.wrap(`${INDEX_PREFIX}${index.name}`);
        let fields = ['_id', '_rev'].concat(index.fields.map(f => f.name));
        let p = Array(fields.length).fill('?');

        return this.db.allDocs({
                startkey: index.doc_type,
                endkey: `${index.doc_type}\uFFFF`,
                include_docs: true,
                skip: start,
                limit: limit
            })
            .then(res => {
                let len = res.rows.length;
                if (!len)
                    return;

                let sqlStatements = res.rows.map(function (r) {
                    let args = fields.map(f => {
                        let v = Utils.resolve(r.doc, f);
                        return typeof v === 'string' ? v.toLowerCase() : v;
                    });
                    return [`INSERT INTO ${tbl} VALUES (${p})`, args];
                });
                return this.provider.batchSql(sqlStatements)
                    .then(() => {
                        if (len === limit)
                            return this.fillIndexTable(index, start + limit);
                    })
            });
    }

    static instance(db, openDatabase?: (name: string) => any) {
        if (db.relIndex)
            return Promise.resolve(null);

        let provider: Provider;
        if (db.adapter === 'cordova-sqlite' && window['sqlitePlugin'])
            provider = new SqliteProvider(db.name);
        else if (db.adapter === 'websql')
            provider = new WebSqlProvider(db.prefix + db.name, openDatabase);
        else
            throw new Error('Relation Index plugin supports only websql or cordova-sqlite adapters');

        db.relIndex = new RelationIndex(db, provider);
        return db.relIndex.init();
    }
}

export function initRelationIndex(openDatabase?: (name: string) => any) {
    let db = this;
    return RelationIndex.instance(db, openDatabase);
}

/* istanbul ignore next */
if (typeof window !== 'undefined' && !!window['PouchDB']) {
    window['PouchDB'].plugin({
        initRelationIndex: initRelationIndex
    } as any);
}