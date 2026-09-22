/**
 * Fast Pedidos - Cloudflare Worker
 * Sincronização Multilojas Bidirecional iFood <-> FastPedidos
 * Suporta Polling Multilojas Simultâneo, Captura de Todos os Status e Logística Sob Demanda
 */

const tokenCache = {};

async function getIFoodToken(clientId, clientSecret) {
  const cacheKey = `${clientId}:${clientSecret}`;
  const now = Date.now();

  if (tokenCache[cacheKey] && tokenCache[cacheKey].expiresAt > now + 30000) {
    return tokenCache[cacheKey].accessToken;
  }

  const params = new URLSearchParams();
  params.append('grantType', 'client_credentials');
  params.append('clientId', clientId);
  params.append('clientSecret', clientSecret);

  const res = await fetch('https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Erro OAuth iFood (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const accessToken = data.accessToken;
  const expiresIn = (data.expiresIn || 3600) * 1000;

  tokenCache[cacheKey] = {
    accessToken,
    expiresAt: now + expiresIn
  };

  return accessToken;
}

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-polling-merchants, Accept',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

function parseIFoodValue(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') {
    return val > 1000 ? val / 100 : val;
  }
  if (typeof val === 'object' && val.value !== undefined) {
    return parseIFoodValue(val.value);
  }
  const parsed = parseFloat(String(val).replace(',', '.'));
  return isNaN(parsed) ? 0 : (parsed > 1000 ? parsed / 100 : parsed);
}

function extractMerchantIds(body) {
  const ids = new Set();
  const allText = [
    ...(Array.isArray(body.allMerchantIds) ? body.allMerchantIds : [body.allMerchantIds]),
    ...(Array.isArray(body.merchantIds) ? body.merchantIds : [body.merchantIds]),
    ...(Array.isArray(body.merchantId) ? body.merchantId : [body.merchantId])
  ].filter(Boolean).join(' ');

  // Remove quebras de linha e espaços internos que possam ter dividido um UUID
  const sanitizedText = allText.replace(/[\r\n\t]/g, '');
  const matches = sanitizedText.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);

  if (matches) {
    matches.forEach(m => ids.add(m.toLowerCase().trim()));
  }

  return Array.from(ids);
}

function mapIFoodStatus(orderStatus, eventCode) {
  const s = String(orderStatus || '').toUpperCase();
  const c = String(eventCode || '').toUpperCase();

  if (c === 'CAN' || c === 'CANCELLED' || c === 'CAR' || c === 'CANCELLATION_REQUESTED' || s === 'CANCELLED' || s === 'CANCELED') return 'cancelado';
  if (c === 'CON' || c === 'CONCLUDED' || s === 'CONCLUDED' || s === 'DELIVERED') return 'concluido';
  if (c === 'DSP' || c === 'DISPATCHED' || s === 'DISPATCHED') return 'despachado';
  if (c === 'RTS' || c === 'RTP' || c === 'READY_TO_PICKUP' || s === 'READY_TO_PICKUP') return 'pronto';
  if (c === 'CFM' || c === 'CONFIRMED' || c === 'INT' || c === 'INTEGRATED' || c === 'PRP' || c === 'PREPARATION_STARTED' || s === 'CONFIRMED' || s === 'IN_PREPARATION') return 'confirmado';
  return 'confirmado';
}

function formatIFoodOrder(raw, eventCode = '') {
  let displayId = raw.displayId || raw.shortOrderNumber || (raw.id ? raw.id.split('-').pop().slice(-4) : '0000');
  displayId = String(displayId).replace(/^#/, '');

  const storeName = raw.merchant?.name || 'Cia do Chopp';
  const merchantId = raw.merchant?.id || '';

  let fullAddress = 'Retirada no Balcão';
  if (raw.delivery && raw.delivery.deliveryAddress) {
    const addr = raw.delivery.deliveryAddress;
    const parts = [];
    if (addr.streetName) {
      let s = addr.streetName;
      if (addr.streetNumber) s += `, ${addr.streetNumber}`;
      if (addr.complement) s += ` (${addr.complement})`;
      parts.push(s);
    }
    if (addr.neighborhood) parts.push(addr.neighborhood);
    if (addr.city) parts.push(addr.city);
    if (addr.reference) parts.push(`Ref: ${addr.reference}`);
    fullAddress = parts.join(' - ') || addr.formattedAddress || 'Endereço sem detalhes';
  }

  const items = (raw.items || []).map(i => {
    const unitP = parseIFoodValue(i.unitPrice?.value ?? i.unitPrice ?? i.price ?? 0);
    const totalP = parseIFoodValue(i.totalPrice?.value ?? i.totalPrice ?? (unitP * (i.quantity || 1)));
    return {
      name: i.name || 'Item iFood',
      price: unitP,
      quantity: i.quantity || 1,
      subtotal: totalP,
      observations: i.observations || i.notes || '',
      options: Array.isArray(i.options || i.subItems) ? (i.options || i.subItems).map(o => o.name || o.title).filter(Boolean) : []
    };
  });

  let total = parseIFoodValue(raw.total?.orderAmount ?? raw.total?.subTotal ?? raw.payments?.total?.value ?? raw.orderAmount ?? 0);
  if (total === 0 && items.length > 0) {
    total = items.reduce((acc, it) => acc + it.subtotal, 0);
  }

  const customerName = raw.customer?.name || raw.customer?.firstName || 'Cliente iFood';

  // Extração 100% dinâmica do Telefone e do ID Localizador exclusivo do iFood
  const rawPhone = raw.customer?.phone;
  const phoneNumber = (typeof rawPhone === 'object' ? (rawPhone?.number || '') : String(rawPhone || '')).trim();
  const rawLocalizer = (typeof rawPhone === 'object' ? (rawPhone?.localizer || '') : '') || raw.delivery?.localizer || raw.localizer || '';
  const cleanLocalizer = String(rawLocalizer || '').trim();
  const formattedLocalizer = cleanLocalizer.length === 8 
    ? `${cleanLocalizer.slice(0, 4)} ${cleanLocalizer.slice(4)}` 
    : cleanLocalizer;

  let customerPhone = phoneNumber;
  if (formattedLocalizer) {
    customerPhone = phoneNumber ? `${phoneNumber} ID: ${formattedLocalizer}` : `ID: ${formattedLocalizer}`;
  }

  const paymentMethod = raw.payments?.methods?.[0]?.name || raw.payments?.methods?.[0]?.method || 'iFood Online';
  
  const orderDate = new Date(raw.createdAt || Date.now());
  const brHours = (orderDate.getUTCHours() - 3 + 24) % 24;
  const formattedTime = `${String(brHours).padStart(2, '0')}:${String(orderDate.getUTCMinutes()).padStart(2, '0')}`;

  const realStatus = mapIFoodStatus(raw.status || raw.orderStatus, eventCode);

  return {
    id: `#IF-${displayId}`,
    displayId: displayId,
    ifoodOrderId: raw.id,
    merchantId: merchantId,
    storeName: storeName,
    customerName: customerName,
    customerPhone: customerPhone,
    phoneLocalizer: formattedLocalizer,
    phoneNumberOnly: phoneNumber,
    customerAddress: fullAddress,
    deliveryMode: raw.delivery?.deliveredBy || 'MERCHANT',
    items: items.length > 0 ? items : [{ name: 'Pedido iFood', price: total, quantity: 1, subtotal: total }],
    totalValue: total,
    paymentMethod: paymentMethod,
    createdAt: formattedTime,
    timestamp: Date.now(),
    status: realStatus,
    isRealIFood: true,
    ifoodDriverStatus: null
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders() });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      // 1. TESTE DE CREDENCIAIS
      if (pathname === '/api/ifood/test-credentials' && request.method === 'POST') {
        const body = await request.json();
        const { clientId, clientSecret } = body;

        if (!clientId || !clientSecret) {
          return new Response(JSON.stringify({ success: false, message: 'ClientId e ClientSecret são obrigatórios.' }), {
            status: 200,
            headers: getCorsHeaders()
          });
        }

        const token = await getIFoodToken(clientId, clientSecret);
        let merchantsList = [];

        try {
          const mRes = await fetch('https://merchant-api.ifood.com.br/merchant/v1.0/merchants', {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (mRes.ok) merchantsList = await mRes.json();
        } catch (e) {}

        return new Response(JSON.stringify({
          success: true,
          message: 'Presença do aplicativo validada com sucesso!',
          merchant: {
            name: merchantsList.length > 0 ? `${merchantsList.length} Lojas Conectadas` : 'Cia do Chopp',
            status: 'OPEN',
            merchants: merchantsList
          }
        }), {
          status: 200,
          headers: getCorsHeaders()
        });
      }

      // 2. STATUS DAS LOJAS (MERCHANTS STATUS)
      if (pathname === '/api/ifood/merchants-status') {
        const clientId = url.searchParams.get('clientId');
        const clientSecret = url.searchParams.get('clientSecret');
        const merchantId = url.searchParams.get('merchantId');

        if (!clientId || !clientSecret) {
          return new Response(JSON.stringify({ success: false, message: 'Faltam credenciais.' }), { status: 200, headers: getCorsHeaders() });
        }

        const token = await getIFoodToken(clientId, clientSecret);
        let storeInfo = null;

        if (merchantId) {
          try {
            const sRes = await fetch(`https://merchant-api.ifood.com.br/merchant/v1.0/merchants/${merchantId}/status`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (sRes.ok) storeInfo = await sRes.json();
          } catch (e) {}
        }

        return new Response(JSON.stringify({
          success: true,
          status: storeInfo || { state: 'OK', message: 'Conectado' }
        }), { status: 200, headers: getCorsHeaders() });
      }

      // 3. BUSCAR PEDIDO ESPECÍFICO POR ID / UUID (PUXAR PEDIDO)
      if (pathname === '/api/ifood/fetch-order-by-id' && request.method === 'POST') {
        const body = await request.json();
        const { orderId, clientId, clientSecret } = body;

        if (!orderId) {
          return new Response(JSON.stringify({ success: false, message: 'ID ou número do pedido é obrigatório.' }), {
            status: 200,
            headers: getCorsHeaders()
          });
        }
        if (!clientId || !clientSecret) {
          return new Response(JSON.stringify({ success: false, message: 'Credenciais iFood não configuradas.' }), {
            status: 200,
            headers: getCorsHeaders()
          });
        }

        const token = await getIFoodToken(clientId, clientSecret);
        const cleanId = String(orderId).replace(/^#IF-/, '').trim();

        const orderRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${cleanId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` }
        });

        if (!orderRes.ok) {
          const errText = await orderRes.text();
          return new Response(JSON.stringify({
            success: false,
            message: `Pedido não localizado no iFood (${orderRes.status}): ${errText}`
          }), {
            status: 200,
            headers: getCorsHeaders()
          });
        }

        const rawOrder = await orderRes.json();
        const formatted = formatIFoodOrder(rawOrder);

        return new Response(JSON.stringify({
          success: true,
          order: formatted
        }), {
          status: 200,
          headers: getCorsHeaders()
        });
      }

      // 4. POLLING SINCRONIZADO MULTILOJAS
      if (pathname === '/api/ifood/poll' && request.method === 'POST') {
        const body = await request.json();
        const { clientId, clientSecret, autoConfirm } = body;
        const knownOrderIds = Array.isArray(body.knownOrderIds) ? body.knownOrderIds : [];

        if (!clientId || !clientSecret) {
          return new Response(JSON.stringify({ success: false, message: 'Faltam credenciais.' }), {
            status: 200,
            headers: getCorsHeaders()
          });
        }

        const token = await getIFoodToken(clientId, clientSecret);
        const merchantIdsList = extractMerchantIds(body);
        
        const pollHeaders = { 
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        };

        // Cabeçalho estrito para o iFood ler TODAS as lojas sem espaços
        if (merchantIdsList.length > 0) {
          pollHeaders['x-polling-merchants'] = merchantIdsList.join(',');
        }

        // Consulta polling com categories=ALL para capturar qualquer pedido de qualquer categoria
        const pollUrl = 'https://merchant-api.ifood.com.br/events/v1.0/events:polling?categories=ALL';
        let pollRes = await fetch(pollUrl, { headers: pollHeaders });

        // Se falhar e estávamos filtrando por merchant, faz fallback sem x-polling-merchants
        // (O iFood retorna eventos de todas as lojas vinculadas à conta quando o header não é enviado)
        if (!pollRes.ok && pollHeaders['x-polling-merchants']) {
          const fbHeaders = { ...pollHeaders };
          delete fbHeaders['x-polling-merchants'];
          const fbRes = await fetch(pollUrl, { headers: fbHeaders });
          if (fbRes.ok || fbRes.status === 204) {
            pollRes = fbRes;
            delete pollHeaders['x-polling-merchants'];
          }
        }

        // Fallback para /order/v1.0/events:polling se o primário não responder
        if (pollRes.status === 404 || pollRes.status === 400) {
          pollRes = await fetch('https://merchant-api.ifood.com.br/order/v1.0/events:polling', {
            headers: pollHeaders
          });
        }

        if (pollRes.status === 204) {
          return new Response(JSON.stringify({ success: true, eventsCount: 0, newOrders: [], updatedEvents: [] }), {
            status: 200,
            headers: getCorsHeaders()
          });
        }

        if (!pollRes.ok) {
          const errTxt = await pollRes.text();
          return new Response(JSON.stringify({ success: false, message: `Erro Polling iFood (${pollRes.status}): ${errTxt}` }), {
            status: 200,
            headers: getCorsHeaders()
          });
        }

        let events = [];
        try {
          events = await pollRes.json();
        } catch (e) {
          events = [];
        }

        const newOrders = [];
        const updatedEvents = [];
        const ackEvents = [];

        // Códigos que acionam a busca completa dos dados do pedido (não apenas PLC!)
        const FETCH_ORDER_CODES = [
          'PLC', 'PLACED',
          'CFM', 'CONFIRMED',
          'INT', 'INTEGRATED',
          'PRP', 'PREPARATION_STARTED',
          'APPROVED',
          'RTP', 'READY_TO_PICKUP', 'RTS',
          'DSP', 'DISPATCHED',
          'SCH', 'SCHEDULED'
        ];

        const CANCEL_CODES = ['CAN', 'CANCELLED', 'CANCELLATION_REQUESTED', 'CAR'];
        const DISPATCH_CODES = ['DSP', 'DISPATCHED'];
        const CONCLUDED_CODES = ['CON', 'CONCLUDED', 'DELIVERED'];
        const DRIVER_ASSIGNED_CODES = ['COLLECT_READY', 'DRIVER_ASSIGNED', 'DRIVER_DISPATCHED', 'ASSIGN_DRIVER'];
        const DRIVER_ARRIVED_CODES = ['DRIVER_ARRIVED_AT_MERCHANT', 'ARRIVED_AT_ORIGIN'];

        if (Array.isArray(events)) {
          for (const evt of events) {
            const code = String(evt.code || '').toUpperCase();
            const fullCode = String(evt.fullCode || '').toUpperCase();
            const orderId = evt.orderId || evt.correlationId || evt.id;

            if (DRIVER_ASSIGNED_CODES.includes(code) || DRIVER_ASSIGNED_CODES.includes(fullCode)) {
              ackEvents.push({ id: evt.id });
              updatedEvents.push({ 
                ifoodOrderId: orderId, 
                driverEvent: 'ASSIGNED', 
                driverName: evt.metadata?.driverName || 'Entregador iFood' 
              });
            } else if (DRIVER_ARRIVED_CODES.includes(code) || DRIVER_ARRIVED_CODES.includes(fullCode)) {
              ackEvents.push({ id: evt.id });
              updatedEvents.push({ ifoodOrderId: orderId, driverEvent: 'ARRIVED' });
            }

            const isKnown = Array.isArray(knownOrderIds) && knownOrderIds.some(id => id === orderId || id.endsWith(orderId) || orderId.endsWith(id));
            const isCancel = CANCEL_CODES.includes(code) || CANCEL_CODES.includes(fullCode);
            const shouldFetchOrder = (!isKnown && !isCancel) || FETCH_ORDER_CODES.includes(code) || FETCH_ORDER_CODES.includes(fullCode);

            if (shouldFetchOrder && !isKnown && orderId) {
              let orderFetched = false;
              let raw = null;

              // Tenta buscar os dados com 1 retry rápido de 300ms caso o microserviço do iFood tenha atraso
              for (let attempt = 0; attempt < 2; attempt++) {
                try {
                  const orderRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}`, {
                    headers: { Authorization: `Bearer ${token}` }
                  });

                  if (orderRes.ok) {
                    raw = await orderRes.json();
                    orderFetched = true;
                    break;
                  }
                } catch (fetchErr) {}

                if (attempt === 0) {
                  await new Promise(r => setTimeout(r, 300));
                }
              }

              if (orderFetched && raw) {
                const formatted = formatIFoodOrder(raw, code);
                newOrders.push(formatted);
                // CRÍTICO: SOMENTE confirma recebimento (acknowledgment) se o pedido foi capturado com sucesso!
                ackEvents.push({ id: evt.id });

                // Auto-confirmação opcional no iFood para pedidos recém-colocados
                if ((code === 'PLC' || fullCode === 'PLACED') && autoConfirm !== false) {
                  try {
                    await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/confirm`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${token}` }
                    });
                  } catch (confErr) {}
                }
              } else {
                console.error(`[FAST PEDIDOS] Detalhes do pedido ${orderId} ainda não disponíveis no iFood. Deixando evento na fila para reentrega imediata no próximo poll.`);
                // NÃO damos ackEvents.push! O iFood reenviará este evento no próximo polling!
              }
            } else {
              // Pedido já conhecido ou evento de transição de status
              ackEvents.push({ id: evt.id });
              if (CANCEL_CODES.includes(code) || CANCEL_CODES.includes(fullCode)) {
                updatedEvents.push({ ifoodOrderId: orderId, newStatus: 'cancelado' });
              } else if (DISPATCH_CODES.includes(code) || DISPATCH_CODES.includes(fullCode)) {
                updatedEvents.push({ ifoodOrderId: orderId, newStatus: 'despachado' });
              } else if (CONCLUDED_CODES.includes(code) || CONCLUDED_CODES.includes(fullCode)) {
                updatedEvents.push({ ifoodOrderId: orderId, newStatus: 'concluido' });
              }
            }
          }

          // Envio de confirmação de recebimento (Acknowledge)
          if (ackEvents.length > 0) {
            const ackHeaders = {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            };
            if (pollHeaders['x-polling-merchants']) {
              ackHeaders['x-polling-merchants'] = pollHeaders['x-polling-merchants'];
            }

            try {
              await fetch('https://merchant-api.ifood.com.br/events/v1.0/events/acknowledgment', {
                method: 'POST',
                headers: ackHeaders,
                body: JSON.stringify(ackEvents)
              });
            } catch (ackErr) {}

            try {
              await fetch('https://merchant-api.ifood.com.br/order/v1.0/events/acknowledgment', {
                method: 'POST',
                headers: ackHeaders,
                body: JSON.stringify(ackEvents)
              });
            } catch (ackErr2) {}
          }
        }

        return new Response(JSON.stringify({ 
          success: true, 
          eventsCount: events.length, 
          newOrders, 
          updatedEvents 
        }), {
          status: 200,
          headers: getCorsHeaders()
        });
      }

      // 5. AÇÕES DE PEDIDO E LOGÍSTICA
      if (pathname === '/api/ifood/order-action' && request.method === 'POST') {
        const body = await request.json();
        const { clientId, clientSecret, ifoodOrderId, action, cancellationCode, reason } = body;

        const token = await getIFoodToken(clientId, clientSecret);

        if (action === 'confirm') {
          const actRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/confirm`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          });
          return new Response(JSON.stringify({ success: actRes.ok, status: actRes.status }), { status: 200, headers: getCorsHeaders() });
        }

        if (action === 'dispatch') {
          const actRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/dispatch`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          });
          return new Response(JSON.stringify({ success: actRes.ok, status: actRes.status }), { status: 200, headers: getCorsHeaders() });
        }

        // CHAMAR MOTOBOY DO IFOOD
        if (action === 'requestDriver') {
          let actRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/requestDriver`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          });

          if (!actRes.ok && actRes.status === 404) {
            actRes = await fetch(`https://merchant-api.ifood.com.br/shipping/v1.0/orders/${ifoodOrderId}/requestDriver`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` }
            });
          }

          if (!actRes.ok && actRes.status === 404) {
            actRes = await fetch(`https://merchant-api.ifood.com.br/logistics/v1.0/orders/${ifoodOrderId}/requestDriver`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` }
            });
          }

          const isOk = actRes.ok;
          const status = actRes.status;
          let errMsg = null;
          if (!isOk) {
            try {
              const errBody = await actRes.json();
              errMsg = errBody.error?.message || errBody.message;
            } catch (_) {}
            if (!errMsg) {
              errMsg = status === 404 
                ? 'O iFood retornou 404: Este pedido ou loja não possui o serviço Entrega Sob Demanda (iFood Sob Medida) habilitado.' 
                : `iFood retornou erro HTTP ${status}`;
            }
          }

          return new Response(JSON.stringify({ 
            success: isOk, 
            status: status, 
            message: errMsg 
          }), { 
            status: 200,
            headers: getCorsHeaders() 
          });
        }

        // CANCELAR CHAMADO DO MOTOBOY IFOOD
        if (action === 'cancelDriver') {
          let actRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/cancelDriver`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          });
          return new Response(JSON.stringify({ success: true, status: actRes.status }), { status: 200, headers: getCorsHeaders() });
        }
        
        if (action === 'delivered') {
          let success = true;
          try {
             await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/delivered`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` }
             });
          } catch(e) { success = false; }
          return new Response(JSON.stringify({ success: success, status: 200 }), { status: 200, headers: getCorsHeaders() });
        }

        if (action === 'requestCancellation') {
          const actRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/requestCancellation`, {
            method: 'POST',
            headers: { 
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              cancellationCode: cancellationCode || '501',
              reason: reason || 'Problemas operacionais'
            })
          });
          return new Response(JSON.stringify({ success: actRes.ok, status: actRes.status }), { status: 200, headers: getCorsHeaders() });
        }

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: getCorsHeaders() });
      }

      return new Response(JSON.stringify({ status: 'online', service: 'Fast Pedidos Multilojas Bidirecional + Logistica' }), {
        status: 200,
        headers: getCorsHeaders()
      });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 200,
        headers: getCorsHeaders()
      });
    }
  }
};
