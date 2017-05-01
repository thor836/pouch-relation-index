PouchDB Relation Index Plugin
=====

Building
----
    npm install
    npm run build

API
-------

* db.createIndex(name, type, fields) - Create Index;
* db.buildIndex(name) - Add data to index table;
* db.queryIndex(name, query, order) - Find documents;
* db.deleteIndex(name) - Delete index;
* db.refreshIndex(name) - Fast refresh index table; Just add a new documents without deleting;

**Options**

* `name`  name of the index
* `type` document type
* `fields` is a list of fields names to index
* `query` selector; example { a: 1, b: 3 $or: [ { c: {$like:'value%'}, d: '4' } ] } in SQL: a = '1' AND b = 3 AND (c LIKE 'value%' OR d = 4)
* `order` is a list of indexed fields names to sort; example: { field_name: 'ASC | DESC' }

**Selectors**

  * `$lt` Matches values that are less than a specified value.
  * `$gt` Matches values that are greater than a specified value.
  * `$lte` Matches values that are less than or equal to a specified value.
  * `$gte` Matches values that are greater than or equal to a specified value.
  * `$like` sql `LIKE` operator. Use _ or % to replace one or many symbols.
  * `$in` Matches any of the values specified in an array; sql `IN` operator.
  * `$nin` Matches none of the values specified in an array; sql `NOT IN` operator.
  * `$and` Joins query clauses with a logical AND returns all documents that match the conditions of both clauses.
  * `$or` Joins query clauses with a logical OR returns all documents that match the conditions of either clause.
