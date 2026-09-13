import { openDatabase } from './storage/database.js';
const db = openDatabase();
console.log(JSON.stringify({ status: 'ready', documents: db.prepare('SELECT count(*) AS count FROM documents').get() }));
db.close();
