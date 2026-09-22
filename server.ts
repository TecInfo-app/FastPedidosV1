import express from 'express';
import path from 'path';
import fs from 'fs';
import webpush from 'web-push';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json());

// Serve static assets from public folder (manifest.json, sw.js, icons)
app.use(express.static(path.join(process.cwd(), 'public')));

// In-memory token cache per clientId
const tokenCache: Record<string, { accessToken: string; expiresAt: number }> = {};

// Tracks orders for which the PDV itself initiated cancellation via requestCancellation.
// When the polling receives a CAR/CANCELLATION_REQUESTED event for these orders,
// we must NOT call acceptCancellation — iFood will send CANCELLED directly.
const pdvInitiatedCancellations = new Set<string>();

// Helper to authenticate with iFood Merchant API
async function getIFoodToken(clientId: string, clientSecret: string): Promise<string> {
  const cacheKey = `${clientId}:${clientSecret}`;
  const now = Date.now();

  if (tokenCache[cacheKey] && tokenCache[cacheKey].expiresAt > now + 60000) {
    return tokenCache[cacheKey].accessToken;
  }

  const params = new URLSearchParams();
  params.append('grantType', 'client_credentials');
  params.append('clientId', clientId);
  params.append('clientSecret', clientSecret);

  const response = await fetch('https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erro de autenticação no iFood (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const accessToken = data.accessToken;
  const expiresIn = (data.expiresIn || 3600) * 1000;

  tokenCache[cacheKey] = {
    accessToken,
    expiresAt: now + expiresIn,
  };

  return accessToken;
}

// API Route: Test iFood Credentials and fetch connected merchants
app.post('/api/ifood/test-credentials', async (req, res) => {
  try {
    const clientId = req.body.clientId || process.env.IFOOD_CLIENT_ID;
    const clientSecret = req.body.clientSecret || process.env.IFOOD_CLIENT_SECRET;
    const merchantId = req.body.merchantId || process.env.IFOOD_MERCHANT_ID || 'cb590ecf-031b-4988-9ee9-83f8912388c8';

    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        message: 'clientId e clientSecret são obrigatórios.'
      });
    }

    const token = await getIFoodToken(clientId, clientSecret);

    // Fetch list of merchants associated with this app
    let merchantsList: any[] = [];
    try {
      const merchantsRes = await fetch('https://merchant-api.ifood.com.br/merchant/v1.0/merchants', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (merchantsRes.ok) {
        merchantsList = await merchantsRes.json();
      }
    } catch (mErr) {
      console.warn('Erro ao consultar lista de merchants:', mErr);
    }

    // Try fetching specific merchant details / status
    let storeDetails: any = null;
    let storeStatus: any = null;
    const targetMerchantId = merchantId || (merchantsList.length > 0 ? merchantsList[0].id : null);

    if (targetMerchantId) {
      try {
        const detailRes = await fetch(`https://merchant-api.ifood.com.br/merchant/v1.0/merchants/${targetMerchantId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (detailRes.ok) {
          storeDetails = await detailRes.json();
        }

        const statusRes = await fetch(`https://merchant-api.ifood.com.br/merchant/v1.0/merchants/${targetMerchantId}/status`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (statusRes.ok) {
          storeStatus = await statusRes.json();
        }
      } catch (sErr) {
        console.warn('Erro ao consultar detalhes da loja:', sErr);
      }
    }

    const storeName = storeDetails?.name || storeDetails?.corporateName || 'christon-restaurante-ltda-teste-c';
    const isOpen = Array.isArray(storeStatus) 
      ? storeStatus.some((s: any) => s.available === true || s.state === 'OK') 
      : (storeStatus?.available !== false);

    return res.json({
      success: true,
      message: 'Autenticado com sucesso no iFood Sandbox/API!',
      tokenPreview: `${token.substring(0, 15)}...`,
      merchant: {
        id: targetMerchantId || 'cb590ecf-031b-4988-9ee9-83f8912388c8',
        name: storeName,
        corporateName: storeDetails?.corporateName || storeName,
        status: isOpen ? 'Aberta' : 'Fechada',
        isOpen: isOpen,
        salesChannel: 'DELIVERY (iFood)',
        merchants: merchantsList
      }
    });
  } catch (error: any) {
    return res.status(401).json({
      success: false,
      message: error.message || 'Falha na autenticação com iFood.'
    });
  }
});

// API Route: Get detailed status of all connected stores
app.get('/api/ifood/merchants-status', async (req, res) => {
  try {
    const { clientId, clientSecret, merchantId } = req.query;
    const cid = (clientId as string) || process.env.IFOOD_CLIENT_ID;
    const csec = (clientSecret as string) || process.env.IFOOD_CLIENT_SECRET;
    const mid = (merchantId as string) || process.env.IFOOD_MERCHANT_ID || 'cb590ecf-031b-4988-9ee9-83f8912388c8';

    if (!cid || !csec) {
      return res.status(400).json({ success: false, message: 'Credenciais não informadas.' });
    }

    const token = await getIFoodToken(cid, csec);

    let merchants: any[] = [];
    try {
      const merchantsRes = await fetch('https://merchant-api.ifood.com.br/merchant/v1.0/merchants', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (merchantsRes.ok) {
        merchants = await merchantsRes.json();
      }
    } catch (e) {}

    let storeDetails: any = null;
    let storeStatus: any = null;
    const targetId = mid || (merchants.length > 0 ? merchants[0].id : 'cb590ecf-031b-4988-9ee9-83f8912388c8');

    if (targetId) {
      try {
        const dRes = await fetch(`https://merchant-api.ifood.com.br/merchant/v1.0/merchants/${targetId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (dRes.ok) storeDetails = await dRes.json();

        const sRes = await fetch(`https://merchant-api.ifood.com.br/merchant/v1.0/merchants/${targetId}/status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (sRes.ok) storeStatus = await sRes.json();
      } catch (e) {}
    }

    const storeName = storeDetails?.name || storeDetails?.corporateName || 'christon-restaurante-ltda-teste-c';
    const isOpen = Array.isArray(storeStatus) 
      ? storeStatus.some((s: any) => s.available === true || s.state === 'OK') 
      : true;

    return res.json({
      success: true,
      connected: true,
      store: {
        id: targetId,
        name: storeName,
        corporateName: storeDetails?.corporateName || storeName,
        status: isOpen ? 'Aberta' : 'Fechada',
        isOpen,
        channel: 'iFood Delivery',
        lastCheck: `${String((new Date().getUTCHours() - 3 + 24) % 24).padStart(2, '0')}:${String(new Date().getUTCMinutes()).padStart(2, '0')}`
      },
      rawStatus: storeStatus,
      merchantsList: merchants
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Helper to format iFood raw order to app order structure
function formatIFoodOrder(rawOrder: any, defaultStatus = 'confirmado') {
  const customerName = rawOrder.customer?.name || rawOrder.customer?.firstName || 'Cliente iFood';

  // Extração 100% dinâmica do Telefone e do ID Localizador exclusivo do iFood
  const rawPhone = rawOrder.customer?.phone;
  const phoneNumber = (typeof rawPhone === 'object' ? (rawPhone?.number || '') : String(rawPhone || '')).trim();
  const rawLocalizer = (typeof rawPhone === 'object' ? (rawPhone?.localizer || '') : '') || rawOrder.delivery?.localizer || rawOrder.localizer || '';
  const cleanLocalizer = String(rawLocalizer || '').trim();
  const formattedLocalizer = cleanLocalizer.length === 8 
    ? `${cleanLocalizer.slice(0, 4)} ${cleanLocalizer.slice(4)}` 
    : cleanLocalizer;

  let customerPhone = phoneNumber;
  if (formattedLocalizer) {
    customerPhone = phoneNumber ? `${phoneNumber} ID: ${formattedLocalizer}` : `ID: ${formattedLocalizer}`;
  }

  // Extract Full Delivery Address
  let customerAddress = '';
  const deliveryData = rawOrder.delivery || {};
  const addr = deliveryData.deliveryAddress || {};
  if (addr.formattedAddress) {
    customerAddress = addr.formattedAddress;
  } else if (addr.streetName) {
    const parts = [];
    let street = addr.streetName;
    if (addr.streetNumber) street += `, ${addr.streetNumber}`;
    if (addr.complement) street += ` (${addr.complement})`;
    parts.push(street);
    if (addr.neighborhood) parts.push(addr.neighborhood);
    if (addr.city) parts.push(`${addr.city}${addr.state ? ' - ' + addr.state : ''}`);
    if (addr.reference) parts.push(`Ref: ${addr.reference}`);
    customerAddress = parts.join(' - ');
  }

  const deliveryMode = deliveryData.deliveredBy || 'MERCHANT';

  const items = (rawOrder.items || []).map((i: any) => ({
    name: i.name || 'Item iFood',
    price: (i.unitPrice || i.price || 0) / (i.unitPrice > 1000 ? 100 : 1),
    quantity: i.quantity || 1,
    subtotal: (i.totalPrice || i.price || 0) / (i.totalPrice > 1000 ? 100 : 1),
    observations: i.observations || i.notes || '',
    options: Array.isArray(i.options || i.subItems) ? (i.options || i.subItems).map((o: any) => o.name || o.title).filter(Boolean) : []
  }));

  const totalValue = (rawOrder.total?.subTotal || rawOrder.total?.orderAmount || rawOrder.payments?.pending || rawOrder.payments?.prepaid || 0) / 
                     ((rawOrder.total?.subTotal > 1000 || rawOrder.total?.orderAmount > 1000) ? 100 : 1);

  const paymentMethod = rawOrder.payments?.methods?.[0]?.name || 'iFood Online';

  const orderDate = new Date(rawOrder.createdAt || Date.now());
  const brHours = (orderDate.getUTCHours() - 3 + 24) % 24;
  const formattedTime = `${String(brHours).padStart(2, '0')}:${String(orderDate.getUTCMinutes()).padStart(2, '0')}`;

  let mappedStatus = defaultStatus;
  const rawStatus = String(rawOrder.orderStatus || rawOrder.status || '').toUpperCase();
  if (rawStatus === 'PLACED') mappedStatus = 'confirmado';
  else if (rawStatus === 'CONFIRMED' || rawStatus === 'IN_PREPARATION') mappedStatus = 'confirmado';
  else if (rawStatus === 'READY_TO_PICKUP') mappedStatus = 'pronto';
  else if (rawStatus === 'DISPATCHED') mappedStatus = 'despachado';
  else if (rawStatus === 'CONCLUDED') mappedStatus = 'concluido';
  else if (rawStatus === 'CANCELLED') mappedStatus = 'cancelado';

  return {
    id: `#IF-${rawOrder.displayId || rawOrder.id.substring(0, 5)}`,
    displayId: String(rawOrder.displayId || rawOrder.id.substring(0, 5)),
    ifoodOrderId: rawOrder.id,
    merchantId: rawOrder.merchant?.id || '',
    merchantName: rawOrder.merchant?.name || '',
    storeName: rawOrder.merchant?.name || '',
    customerName,
    customerPhone,
    phoneLocalizer: formattedLocalizer,
    phoneNumberOnly: phoneNumber,
    customerAddress: customerAddress || 'Endereço não informado',
    deliveryMode,
    items: items.length > 0 ? items : [{ name: 'Pedido iFood', price: totalValue || 25.0, quantity: 1, subtotal: totalValue || 25.0 }],
    totalValue: totalValue || 25.0,
    paymentMethod,
    createdAt: formattedTime,
    timestamp: Date.now(),
    status: mappedStatus,
    isRealIFood: true,
    ifoodDriverStatus: null
  };
}

// API Route: Poll Events from iFood API
app.post('/api/ifood/poll', async (req, res) => {
  try {
    const clientId = req.body.clientId || process.env.IFOOD_CLIENT_ID;
    const clientSecret = req.body.clientSecret || process.env.IFOOD_CLIENT_SECRET;
    const merchantId = req.body.merchantId || process.env.IFOOD_MERCHANT_ID;
    const autoConfirm = req.body.autoConfirm !== undefined ? req.body.autoConfirm : true;
    const knownOrderIds: string[] = Array.isArray(req.body.knownOrderIds) ? req.body.knownOrderIds : [];

    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        message: 'Credenciais do iFood não configuradas.'
      });
    }

    const token = await getIFoodToken(clientId, clientSecret);

    // Call iFood Events Polling with categories=ALL
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    };

    let cleanMerchants = '';
    if (merchantId && typeof merchantId === 'string' && merchantId.trim() !== '') {
      cleanMerchants = merchantId.split(',').map((m: string) => m.trim()).filter(Boolean).join(',');
    }

    // Auto-discover merchants if none provided
    if (!cleanMerchants) {
      try {
        const mRes = await fetch('https://merchant-api.ifood.com.br/merchant/v1.0/merchants', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (mRes.ok) {
          const mList: any = await mRes.json();
          if (Array.isArray(mList) && mList.length > 0) {
            cleanMerchants = mList.map((m: any) => m.id).filter(Boolean).join(',');
          }
        }
      } catch (mErr) {}
    }

    if (cleanMerchants) {
      headers['x-polling-merchants'] = cleanMerchants;
    }

    const pollUrl = 'https://merchant-api.ifood.com.br/events/v1.0/events:polling?categories=ALL';
    let pollRes = await fetch(pollUrl, { method: 'GET', headers });

    // Fallback without x-polling-merchants if 204 or error to capture account-wide events
    if ((pollRes.status === 204 || !pollRes.ok) && headers['x-polling-merchants']) {
      const fbHeaders = { ...headers };
      delete fbHeaders['x-polling-merchants'];
      const fbRes = await fetch(pollUrl, { method: 'GET', headers: fbHeaders });
      if (fbRes.ok && fbRes.status !== 204) {
        pollRes = fbRes;
        delete headers['x-polling-merchants'];
      }
    }

    if (pollRes.status === 404 || pollRes.status === 400) {
      pollRes = await fetch('https://merchant-api.ifood.com.br/order/v1.0/events:polling', {
        headers
      });
    }

    if (pollRes.status === 204) {
      return res.json({ success: true, eventsCount: 0, newOrders: [], updatedEvents: [] });
    }

    if (!pollRes.ok) {
      const errText = await pollRes.text();
      return res.status(pollRes.status).json({
        success: false,
        message: `Erro ao buscar eventos do iFood (${pollRes.status}): ${errText}`
      });
    }

    const events = await pollRes.json();
    if (!Array.isArray(events) || events.length === 0) {
      return res.json({ success: true, eventsCount: 0, newOrders: [], updatedEvents: [] });
    }

    const newOrders: any[] = [];
    const updatedEvents: any[] = [];
    const ackEvents: { id: string }[] = [];

    for (const evt of events) {
      const code = String(evt.code || '').toUpperCase();
      const fullCode = String(evt.fullCode || '').toUpperCase();
      const allCodes = `${code} ${fullCode}`;
      const orderId = evt.orderId || evt.correlationId || evt.metadata?.orderId || evt.metadata?.id || evt.id;

      const isCancellationRequested = (
        code === 'CAR' || code === 'CPR' || code === 'CCR' || code === 'CRQ' ||
        allCodes.includes('CANCELLATION_REQUEST') || allCodes.includes('CANCELLATION_REQUESTED') || allCodes.includes('CANCEL_REQUEST')
      );
      
      const isCancelled = (
        code === 'CAN' || code === 'COD' || allCodes.includes('CANCELLED') || allCodes.includes('CANCELED')
      );

      const isDriverAssigned = code === 'ADR' || fullCode === 'ASSIGNED_DRIVER' || allCodes.includes('ASSIGNED_DRIVER') || allCodes.includes('DRIVER_ASSIGNED');
      const isDriverGoingToOrigin = code === 'GTO' || fullCode === 'GOING_TO_ORIGIN' || allCodes.includes('GOING_TO_ORIGIN');
      const isDriverArrivedAtOrigin = code === 'AAO' || fullCode === 'ARRIVED_AT_ORIGIN' || allCodes.includes('ARRIVED_AT_ORIGIN') || allCodes.includes('DRIVER_ARRIVED');
      const isDriverDispatched = code === 'DCO' || fullCode === 'COLLECTED' || allCodes.includes('COLLECTED') || allCodes.includes('DRIVER_DISPATCHED');

      if (isDriverAssigned && orderId) {
        ackEvents.push({ id: evt.id });
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          driverStatus: 'ASSIGNED',
          driverEvent: 'ASSIGNED',
          driverName: evt.metadata?.driverName || 'Entregador iFood'
        });
      } else if (isDriverGoingToOrigin && orderId) {
        ackEvents.push({ id: evt.id });
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          driverStatus: 'GOING_TO_ORIGIN'
        });
      } else if (isDriverArrivedAtOrigin && orderId) {
        ackEvents.push({ id: evt.id });
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          driverStatus: 'ARRIVED_AT_ORIGIN',
          driverEvent: 'ARRIVED'
        });
      } else if (isDriverDispatched && orderId) {
        ackEvents.push({ id: evt.id });
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          driverStatus: 'DISPATCHED'
        });
      } else if (isCancellationRequested && orderId) {
        ackEvents.push({ id: evt.id });
        if (!pdvInitiatedCancellations.has(orderId)) {
          try {
            fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/cancellationReasons`, {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${token}` }
            }).catch(() => {});

            await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/acceptCancellation`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({})
            });
          } catch (cancelErr) {}
        }
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          newStatus: 'cancelado'
        });
      } else if (isCancelled && orderId) {
        ackEvents.push({ id: evt.id });
        pdvInitiatedCancellations.delete(orderId);
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          newStatus: 'cancelado'
        });
      } else if (orderId) {
        const isKnown = knownOrderIds.some(id => id === orderId || id.endsWith(orderId) || orderId.endsWith(id));

        const shouldFetch = !isKnown || (
          code === 'PLC' || fullCode === 'PLACED' || allCodes.includes('PLACED') ||
          code === 'CFM' || fullCode === 'CONFIRMED' || allCodes.includes('CONFIRMED') ||
          code === 'INT' || fullCode === 'INTEGRATED' || allCodes.includes('INTEGRATED') ||
          code === 'PRP' || allCodes.includes('PREPARATION') ||
          code === 'RTP' || allCodes.includes('READY') ||
          code === 'DSP' || allCodes.includes('DISPATCH') ||
          code === 'SCH' || allCodes.includes('SCHEDULED') ||
          allCodes.includes('TAKEOUT') || allCodes.includes('DELIVERY')
        );

        if (shouldFetch && !isKnown) {
          let orderFetched = false;
          let rawOrder: any = null;

          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const orderRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
              });

              if (orderRes.ok) {
                rawOrder = await orderRes.json();
                orderFetched = true;
                break;
              }
            } catch (orderErr) {}

            if (attempt === 0) {
              await new Promise(r => setTimeout(r, 300));
            }
          }

          if (orderFetched && rawOrder) {
            const isPlaced = code === 'PLC' || fullCode === 'PLACED' || allCodes.includes('PLACED');
            let initialStatus = 'confirmado';

            if (isPlaced && autoConfirm) {
              try {
                await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/confirm`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}` }
                });
              } catch (confirmErr) {}
            }

            const formatted = formatIFoodOrder(rawOrder, initialStatus);
            newOrders.push(formatted);
            ackEvents.push({ id: evt.id });
          } else {
            console.warn(`[POLL SAFEGUARD] Pedido ${orderId} ainda processando no iFood. Deixando evento na fila para entrega imediata.`);
            // Critical: DO NOT ack this event so iFood redelivers it on next poll
          }
        } else {
          // Known order update
          ackEvents.push({ id: evt.id });
          const isConcluded = code === 'CON' || fullCode === 'CONCLUDED' || allCodes.includes('CONCLUDED') || allCodes.includes('DELIVERED');
          const isDispatched = code === 'DSP' || fullCode === 'DISPATCHED' || allCodes.includes('DISPATCH');
          const isReady = code === 'RTP' || fullCode === 'READY_TO_PICKUP' || allCodes.includes('READY');

          if (isConcluded) {
            updatedEvents.push({ ifoodOrderId: orderId, code: evt.code, newStatus: 'concluido' });
          } else if (isDispatched) {
            updatedEvents.push({ ifoodOrderId: orderId, code: evt.code, newStatus: 'despachado' });
          } else if (isReady) {
            updatedEvents.push({ ifoodOrderId: orderId, code: evt.code, newStatus: 'pronto' });
          }
        }
      } else {
        ackEvents.push({ id: evt.id });
      }
    }

    // Only acknowledge events that were successfully handled!
    if (ackEvents.length > 0) {
      const ackHeaders: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      };
      if (headers['x-polling-merchants']) {
        ackHeaders['x-polling-merchants'] = headers['x-polling-merchants'];
      }

      try {
        await fetch('https://merchant-api.ifood.com.br/events/v1.0/events/acknowledgment', {
          method: 'POST',
          headers: ackHeaders,
          body: JSON.stringify(ackEvents)
        });
      } catch (ackError) {}

      try {
        await fetch('https://merchant-api.ifood.com.br/order/v1.0/events/acknowledgment', {
          method: 'POST',
          headers: ackHeaders,
          body: JSON.stringify(ackEvents)
        });
      } catch (orderAckErr) {}
    }

    return res.json({
      success: true,
      eventsCount: events.length,
      newOrders,
      updatedEvents
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Erro no servidor durante polling.'
    });
  }
});

// API Route: Direct Search / Fetch Order by ID
app.post('/api/ifood/fetch-order-by-id', async (req, res) => {
  try {
    const { orderId, clientId, clientSecret } = req.body;
    const cid = clientId || process.env.IFOOD_CLIENT_ID;
    const csec = clientSecret || process.env.IFOOD_CLIENT_SECRET;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'ID ou número do pedido é obrigatório.' });
    }
    if (!cid || !csec) {
      return res.status(400).json({ success: false, message: 'Credenciais iFood não configuradas.' });
    }

    const token = await getIFoodToken(cid, csec);
    const cleanId = String(orderId).replace(/^#IF-/, '').trim();

    const orderRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${cleanId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!orderRes.ok) {
      const errText = await orderRes.text();
      return res.status(orderRes.status).json({
        success: false,
        message: `Pedido não encontrado no iFood (${orderRes.status}): ${errText}`
      });
    }

    const rawOrder = await orderRes.json();
    const formatted = formatIFoodOrder(rawOrder);

    return res.json({
      success: true,
      order: formatted
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Erro ao buscar pedido por ID.'
    });
  }
});

// API Route: Action on iFood Order (Confirm/Dispatch)
app.post('/api/ifood/order-action', async (req, res) => {
  try {
    const { ifoodOrderId, action, clientId, clientSecret } = req.body;
    const cid = clientId || process.env.IFOOD_CLIENT_ID;
    const csec = clientSecret || process.env.IFOOD_CLIENT_SECRET;

    if (!ifoodOrderId || !action) {
      return res.status(400).json({ success: false, message: 'ifoodOrderId e action são necessários.' });
    }

    if (!cid || !csec) {
      return res.status(400).json({ success: false, message: 'Credenciais iFood não configuradas.' });
    }

    const token = await getIFoodToken(cid, csec);

    let endpoint = '';
    let reqBody: any = null;
    if (action === 'confirm') {
      endpoint = `https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/confirm`;
    } else if (action === 'dispatch') {
      // Garante que o pedido esteja confirmado no iFood antes de despachar
      try {
        await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/confirm`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch (confirmErr) {
        // Se já estiver confirmado, ignora e prossegue para o dispatch
      }
      endpoint = `https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/dispatch`;
    } else if (action === 'readyToPickup') {
      endpoint = `https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/readyToPickup`;
    } else if (action === 'requestDriver') {
      endpoint = `https://merchant-api.ifood.com.br/shipping/v1.0/orders/${ifoodOrderId}/requestDriver`;
      reqBody = JSON.stringify({});
    } else if (action === 'requestCancellation') {
      // Step 1: Query cancellation reasons from iFood API or use provided code/reason
      let cancellationCode = req.body.cancellationCode || '501';
      let cancellationReason = req.body.reason || 'Cancelamento solicitado pelo PDV';
      
      if (!req.body.cancellationCode) {
        try {
          console.log(`[iFood Homologation] Querying cancellation reasons for order ${ifoodOrderId}...`);
          const reasonsRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/cancellationReasons`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          console.log(`[iFood Homologation] cancellationReasons HTTP status: ${reasonsRes.status}`);
          if (reasonsRes.ok) {
            const reasonsData = await reasonsRes.json();
            console.log(`[iFood Homologation] cancellationReasons data:`, JSON.stringify(reasonsData));
            const list = Array.isArray(reasonsData) ? reasonsData : (reasonsData.data || reasonsData.cancellationReasons || []);
            if (list.length > 0) {
              const firstReason = list[0];
              cancellationCode = String(firstReason.cancelCodeId || firstReason.cancellationCode || firstReason.id || firstReason.code || '501');
              cancellationReason = firstReason.description || firstReason.reason || cancellationReason;
            }
          }
        } catch (reasonErr) {
          console.error('Erro ao buscar motivos de cancelamento:', reasonErr);
        }
      }

      endpoint = `https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/requestCancellation`;
      reqBody = JSON.stringify({
        cancellationCode: cancellationCode,
        reason: cancellationReason || cancellationCode
      });
      console.log(`[FIREFLY AUDIT CANCEL] Timestamp: ${new Date().toISOString()} | requestCancellation for order ${ifoodOrderId} | body: ${reqBody}`);
      // Mark this order as PDV-initiated cancellation so the polling loop
      // does NOT call acceptCancellation when the resulting CAR event arrives
      pdvInitiatedCancellations.add(ifoodOrderId);
    } else if (action === 'acceptCancellation') {
      endpoint = `https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/acceptCancellation`;
      reqBody = JSON.stringify({});
    } else {
      return res.status(400).json({ success: false, message: 'Ação não suportada.' });
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`
    };
    if (reqBody) {
      headers['Content-Type'] = 'application/json';
    }

    const actionRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: reqBody || undefined
    });

    const isCancellationAction = action === 'requestCancellation' || action === 'acceptCancellation';
    const isAcceptableStatus = actionRes.ok || actionRes.status === 202 || actionRes.status === 200
      || (isCancellationAction && (actionRes.status === 400 || actionRes.status === 409));

    if (!isAcceptableStatus) {
      const errText = await actionRes.text();
      console.error(`[FIREFLY AUDIT ${action.toUpperCase()} ERROR] Timestamp: ${new Date().toISOString()} | action=${action} order=${ifoodOrderId} | HTTP ${actionRes.status}: ${errText}`);
      return res.status(actionRes.status).json({
        success: false,
        message: `Ação no iFood retornou status ${actionRes.status}: ${errText}`
      });
    }

    console.log(`[FIREFLY AUDIT ${action.toUpperCase()} SUCCESS] Timestamp: ${new Date().toISOString()} | action=${action} OK for order ${ifoodOrderId} | HTTP ${actionRes.status}`);
    return res.json({ success: true, message: `Status do pedido atualizado para '${action}' no iFood.` });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Erro ao executar ação no iFood.'
    });
  }
});

// API Route: Get Cancellation Reasons for an Order (Audited by iFood Homologation)
app.get('/api/ifood/cancellation-reasons', async (req, res) => {
  try {
    const { ifoodOrderId, clientId, clientSecret } = req.query;
    const cid = (clientId as string) || process.env.IFOOD_CLIENT_ID;
    const csec = (clientSecret as string) || process.env.IFOOD_CLIENT_SECRET;

    if (!ifoodOrderId) {
      return res.status(400).json({ success: false, message: 'ifoodOrderId é necessário.' });
    }
    if (!cid || !csec) {
      return res.status(400).json({ success: false, message: 'Credenciais iFood não configuradas.' });
    }

    const token = await getIFoodToken(cid, csec);
    const reasonsRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/cancellationReasons`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!reasonsRes.ok) {
      const errText = await reasonsRes.text();
      return res.status(reasonsRes.status).json({ success: false, message: errText });
    }

    const data = await reasonsRes.json();
    return res.json({ success: true, reasons: data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API Route: Cancel Order by ID directly for Homologation audit
app.post('/api/ifood/cancel-by-id', async (req, res) => {
  try {
    const { ifoodOrderId, clientId, clientSecret } = req.body;
    const cid = clientId || process.env.IFOOD_CLIENT_ID;
    const csec = clientSecret || process.env.IFOOD_CLIENT_SECRET;

    if (!ifoodOrderId) {
      return res.status(400).json({ success: false, message: 'ID do Pedido iFood é obrigatório.' });
    }
    if (!cid || !csec) {
      return res.status(400).json({ success: false, message: 'Credenciais iFood não configuradas.' });
    }

    const token = await getIFoodToken(cid, csec);
    const results: any = {};

    // 1. Audit query: GET cancellationReasons (mandatory for homologation)
    let cancelCode = '501';
    let cancelReason = 'Cancelamento solicitado para homologação';
    try {
      console.log(`[FIREFLY AUDIT CANCEL] Timestamp: ${new Date().toISOString()} | Querying cancellationReasons for order ${ifoodOrderId}...`);
      const reasonsRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/cancellationReasons`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      results.cancellationReasonsStatus = reasonsRes.status;
      console.log(`[FIREFLY AUDIT CANCEL] Timestamp: ${new Date().toISOString()} | cancellationReasons HTTP ${reasonsRes.status} for order ${ifoodOrderId}`);
      if (reasonsRes.ok) {
        const rData = await reasonsRes.json();
        results.cancellationReasonsData = rData;
        if (Array.isArray(rData) && rData.length > 0) {
          cancelCode = String(rData[0].cancelCodeId || rData[0].cancellationCode || rData[0].id || rData[0].code || '501');
          cancelReason = rData[0].description || rData[0].reason || cancelReason;
        }
      }
    } catch (e: any) {
      results.cancellationReasonsError = e.message;
    }

    // 2. POST requestCancellation — PDV-initiated flow; iFood will send CANCELLED directly (no acceptCancellation needed)
    try {
      // Mark as PDV-initiated so polling won't call acceptCancellation on the resulting CAR event
      pdvInitiatedCancellations.add(ifoodOrderId);
      const reqBody = JSON.stringify({ reason: cancelReason, cancellationCode: cancelCode });
      console.log(`[FIREFLY AUDIT CANCEL] Timestamp: ${new Date().toISOString()} | requestCancellation for order ${ifoodOrderId} | body: ${reqBody}`);
      const reqCancelRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/requestCancellation`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: reqBody
      });
      results.requestCancellationStatus = reqCancelRes.status;
      console.log(`[FIREFLY AUDIT CANCEL SUCCESS] Timestamp: ${new Date().toISOString()} | requestCancellation HTTP ${reqCancelRes.status} for order ${ifoodOrderId} — cancelamento registrado no iFood.`);
    } catch (e: any) {
      results.requestCancellationError = e.message;
      console.error(`[FIREFLY AUDIT CANCEL ERROR] Timestamp: ${new Date().toISOString()} | requestCancellation exception for order ${ifoodOrderId}:`, e.message);
    }

    // NOTE: acceptCancellation is NOT called here.
    // When the PDV initiates requestCancellation, iFood processes and sends CANCELLED (CAN) directly.
    // The polling loop handles the resulting CAR event and skips acceptCancellation for PDV-initiated flows.

    return res.json({
      success: true,
      message: `Solicitações de cancelamento enviadas para o pedido ${ifoodOrderId}`,
      details: results
    });

  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API Route: Get Driver Tracking Status for an iFood Order
app.get('/api/ifood/driver-tracking', async (req, res) => {
  try {
    const { ifoodOrderId, clientId, clientSecret } = req.query;
    const cid = (clientId as string) || process.env.IFOOD_CLIENT_ID;
    const csec = (clientSecret as string) || process.env.IFOOD_CLIENT_SECRET;

    if (!ifoodOrderId) {
      return res.status(400).json({ success: false, message: 'ifoodOrderId é obrigatório.' });
    }
    if (!cid || !csec) {
      return res.status(400).json({ success: false, message: 'Credenciais iFood não configuradas.' });
    }

    const token = await getIFoodToken(cid, csec);

    let trackingRes = await fetch(`https://merchant-api.ifood.com.br/shipping/v1.0/orders/${ifoodOrderId}/tracking`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!trackingRes.ok) {
      trackingRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${ifoodOrderId}/tracking`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }

    if (trackingRes.ok) {
      const trackingData = await trackingRes.json();
      return res.json({ success: true, tracking: trackingData });
    } else {
      const errText = await trackingRes.text();
      return res.status(trackingRes.status).json({ success: false, message: `Erro ao consultar rastreamento: ${errText}` });
    }
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Erro interno no tracking de entregador.' });
  }
});

// ============================================================================
// --- SERVIÇO DE WEB PUSH & NOTIFICAÇÕES EM SEGUNDO PLANO (MOTOBOY PWA) ---
// ============================================================================
interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const VAPID_KEYS_FILE = path.join(process.cwd(), 'vapid-keys.json');
let activeVapidKeys: VapidKeys;

// Se o usuário configurar suas chaves customizadas ou se existir no .env
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  activeVapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  };
} else if (fs.existsSync(VAPID_KEYS_FILE)) {
  try {
    activeVapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, 'utf-8'));
  } catch (e) {
    activeVapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(activeVapidKeys, null, 2));
  }
} else {
  // Gera par de chaves VAPID automaticamente para funcionamento imediato sem necessidade de setup manual
  activeVapidKeys = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(activeVapidKeys, null, 2));
    console.log('[WebPush] Par de chaves VAPID gerado e salvo em vapid-keys.json');
  } catch (e) {
    console.warn('[WebPush] Não foi possível salvar vapid-keys.json:', e);
  }
}

try {
  webpush.setVapidDetails(
    'mailto:ciadochopp.contato@gmail.com',
    activeVapidKeys.publicKey,
    activeVapidKeys.privateKey
  );
  console.log('[WebPush] Chaves VAPID ativas. Chave Pública:', activeVapidKeys.publicKey.substring(0, 16) + '...');
} catch (err) {
  console.error('[WebPush] Erro ao configurar VAPID details:', err);
}

// Arquivo de persistência de inscrições dos motoboys
const SUBSCRIPTIONS_FILE = path.join(process.cwd(), 'motoboy-subscriptions.json');
let motoboySubscriptions: Record<string, webpush.PushSubscription[]> = {};

try {
  if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
    motoboySubscriptions = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'));
  }
} catch (e) {
  motoboySubscriptions = {};
}

function saveMotoboySubscriptions() {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(motoboySubscriptions, null, 2));
  } catch (e) {
    console.warn('[WebPush] Erro ao salvar inscrições de motoboys:', e);
  }
}

// Rota para o frontend obter a Chave Pública VAPID
app.get('/api/push/public-key', (req, res) => {
  res.json({
    success: true,
    publicKey: activeVapidKeys.publicKey
  });
});

// Rota para salvar a inscrição Web Push de um motoboy
app.post('/api/push/subscribe', (req, res) => {
  try {
    const { motoboyId, subscription } = req.body;
    if (!motoboyId || !subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, message: 'motoboyId e subscription são obrigatórios' });
    }

    const key = String(motoboyId);
    if (!motoboySubscriptions[key]) {
      motoboySubscriptions[key] = [];
    }

    // Evita duplicar endpoint idêntico
    motoboySubscriptions[key] = motoboySubscriptions[key].filter(s => s.endpoint !== subscription.endpoint);
    motoboySubscriptions[key].push(subscription);
    saveMotoboySubscriptions();

    console.log(`[WebPush] Inscrição salva para motoboy #${key}. Total de dispositivos: ${motoboySubscriptions[key].length}`);
    return res.json({ success: true, count: motoboySubscriptions[key].length });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Rota para enviar notificação Push para o motoboy (mesmo com navegador fechado)
app.post('/api/push/send-to-motoboy', async (req, res) => {
  try {
    const { motoboyId, order, customTitle, customBody } = req.body;
    if (!motoboyId) {
      return res.status(400).json({ success: false, message: 'motoboyId é obrigatório' });
    }

    const key = String(motoboyId);
    const subs = motoboySubscriptions[key] || [];

    if (subs.length === 0) {
      return res.json({ success: false, sentCount: 0, message: 'Nenhum dispositivo cadastrado para este motoboy.' });
    }

    const orderNum = order?.orderNumber || order?.id || '';
    const feeStr = order?.deliveryFee ? `Taxa: R$ ${Number(order.deliveryFee).toFixed(2)}` : '';
    const custName = order?.customerName ? ` • ${order.customerName}` : '';
    const custAddr = order?.customerAddress ? `\n📍 ${order.customerAddress}` : '';

    const payload = JSON.stringify({
      title: customTitle || `🛵 Pedido #${orderNum} Chegou!`,
      body: customBody || `${feeStr}${custName}${custAddr}`,
      orderId: String(order?.id || Date.now()),
      tag: `order-${order?.id || Date.now()}`,
      url: '/?portal=motoboy'
    });

    let successCount = 0;
    const deadSubs: string[] = [];

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
          successCount++;
        } catch (err: any) {
          console.warn(`[WebPush] Falha no envio: status ${err.statusCode || err.message}`);
          if (err.statusCode === 410 || err.statusCode === 404) {
            deadSubs.push(sub.endpoint);
          }
        }
      })
    );

    if (deadSubs.length > 0) {
      motoboySubscriptions[key] = subs.filter(s => !deadSubs.includes(s.endpoint));
      saveMotoboySubscriptions();
    }

    return res.json({ success: true, sentCount: successCount, totalDevices: subs.length });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Rota de teste imediato de push
app.post('/api/push/test', async (req, res) => {
  try {
    const { motoboyId } = req.body;
    if (!motoboyId) return res.status(400).json({ success: false, message: 'motoboyId é obrigatório' });

    const key = String(motoboyId);
    const subs = motoboySubscriptions[key] || [];
    if (subs.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Nenhum celular cadastrado para este motoboy. Abra o portal no celular e clique em "Ativar Alertas Push" primeiro.'
      });
    }

    const payload = JSON.stringify({
      title: '🛵 Alerta Push Recebido!',
      body: 'Seu smartphone recebeu a notificação em segundo plano com sucesso! Pronto para entregas.',
      orderId: 'test-' + Date.now(),
      url: '/?portal=motoboy'
    });

    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (e: any) {
        console.warn('[WebPush] Falha no envio de teste:', e.message);
      }
    }

    return res.json({ success: true, sentCount: sent, totalDevices: subs.length });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

async function startServer() {
  // Mount Vite in dev mode or serve static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
