const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

// Update Login title
code = code.replace(
`<h2 class="text-2xl font-black tracking-tight text-white">CIA DO CHOPP</h2>`,
`<h2 class="text-2xl font-black tracking-tight text-white">FAST PEDIDOS</h2>`
);

code = code.replace(
`<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black bg-amber-400/20 text-amber-400 border border-amber-400/30 uppercase tracking-widest mt-2">
          ⚡ FAST PEDIDOS &bull; LOGIN
        </span>`,
`<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black bg-amber-400/20 text-amber-400 border border-amber-400/30 uppercase tracking-widest mt-2">
          ⚡ ACESSO AO SISTEMA
        </span>`
);

code = code.replace(
`placeholder="ex: admin@ciadochopp.com.br ou felipe"`,
`placeholder="ex: contato@loja.com.br ou admin"`
);

// Update Header to show dynamic store name
code = code.replace(
`<h1 class="text-base sm:text-2xl font-black tracking-tight text-white truncate">CIA DO CHOPP</h1>`,
`<h1 id="main-header-store-name" class="text-base sm:text-2xl font-black tracking-tight text-white truncate">FAST PEDIDOS</h1>`
);

fs.writeFileSync('index.html', code);
