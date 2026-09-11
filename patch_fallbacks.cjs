const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

code = code.replace(
`{ id: 'store-cia', name: 'CIA DO CHOPP', active: true }`,
`{ id: 'store-principal', name: 'Loja Principal', active: true }`
);

code = code.replace(/CIA DO CHOPP/g, 'Minha Loja');

fs.writeFileSync('index.html', code);
