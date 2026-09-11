const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

code = code.replace(
`          // Sync drawer form
          const dCid = document.getElementById('drawer-cfg-client-id');
          const dCsec = document.getElementById('drawer-cfg-client-secret');
          const dMid = document.getElementById('drawer-cfg-merchant-id');
          const dUrl = document.getElementById('drawer-cfg-custom-url');

          if (dCid) dCid.value = apiCredentials.clientId || '';
          if (dCsec) dCsec.value = apiCredentials.clientSecret || '';
          if (dMid) dMid.value = apiCredentials.merchantId || '';
          if (dUrl) dUrl.value = apiCredentials.customApiUrl || (window.location.hostname.includes('github.io') ? 'https://ifood-integracao.iranildo-jobs.workers.dev' : '');
        } catch (e) {}`,
`          // Sync drawer form
          const dStoreName = document.getElementById('drawer-cfg-store-name');
          const dCid = document.getElementById('drawer-cfg-client-id');
          const dCsec = document.getElementById('drawer-cfg-client-secret');
          const dMid = document.getElementById('drawer-cfg-merchant-id');
          const dUrl = document.getElementById('drawer-cfg-custom-url');

          if (dStoreName) dStoreName.value = apiCredentials.storeName || '';
          if (dCid) dCid.value = apiCredentials.clientId || '';
          if (dCsec) dCsec.value = apiCredentials.clientSecret || '';
          if (dMid) dMid.value = apiCredentials.merchantId || '';
          if (dUrl) dUrl.value = apiCredentials.customApiUrl || (window.location.hostname.includes('github.io') ? 'https://ifood-integracao.iranildo-jobs.workers.dev' : '');
          
          const mainHeaderName = document.getElementById('main-header-store-name');
          if (mainHeaderName) {
             mainHeaderName.innerText = apiCredentials.storeName || 'FAST PEDIDOS';
          }
        } catch (e) {}`
);

fs.writeFileSync('index.html', code);
