const esc = (v) => (String(v).includes(',') ? '"' + String(v).replace(/"/g, '""') + '"' : v);
exports.toCsv = (rows) => rows.map((r) => r.map(esc).join(',')).join('\n');
exports.toJson = (rows) => JSON.stringify(rows);
