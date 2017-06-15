import vuvuzela from "vuvuzela";
import {Field} from "./types";

export default class Utils {
    static wrap(op: string | string[]): string {
        if (Array.isArray(op)) {
            return op.map(f => '`' + f + '`').join();
        } else {
            return `\`${op}\``;
        }
    }

    static fieldsToSql(fields: Field[]) {
        return fields.map(f => `${Utils.wrap(f.name)} ${f.type}`).join();
    }

    static resolve(obj: {}, path: string, defValue: any = null) {
        return path.split(".").reduce((o, p) => o && o[p], obj) || defValue;
    }

    static eachAsync(data, iterator, callback) {
        let index = 0;
        let len = data.length;
        let next = (e?) => {
            if (!e && index < len) {
                iterator(data[index], next);
                index++;
            } else {
                typeof callback === 'function' && callback(e);
            }
        };
        next();
    }

    static unstringifyDoc (doc, id, rev) {
        doc = Utils.safeJsonParse(doc);
        doc._id = id;
        doc._rev = rev;
        return doc;
    }

    static safeJsonParse(str) {
        try {
            return JSON.parse(str);
        } catch (e) {
            /* istanbul ignore next */
            return vuvuzela.parse(str);
        }
    }
}