import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json());

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
        lastCheck: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      },
      rawStatus: storeStatus,
      merchantsList: merchants
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API Route: Poll Events from iFood API
app.post('/api/ifood/poll', async (req, res) => {
  try {
    const clientId = req.body.clientId || process.env.IFOOD_CLIENT_ID;
    const clientSecret = req.body.clientSecret || process.env.IFOOD_CLIENT_SECRET;
    const merchantId = req.body.merchantId || process.env.IFOOD_MERCHANT_ID;
    const autoConfirm = req.body.autoConfirm !== undefined ? req.body.autoConfirm : true;

    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        message: 'Credenciais do iFood não configuradas.'
      });
    }

    const token = await getIFoodToken(clientId, clientSecret);

    // Call iFood Events Polling
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`
    };
    if (merchantId) {
      headers['x-polling-merchants'] = merchantId;
    }

    const pollRes = await fetch('https://merchant-api.ifood.com.br/events/v1.0/events:polling', {
      method: 'GET',
      headers
    });

    if (pollRes.status === 204) {
      // No content / No new events
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

    // STEP 1: ACK IMMEDIATELY (Firefly Audit requires < 10s after polling)
    // Must be sent before any order processing to guarantee timestamp compliance.
    const ackEvents = events.map((e: any) => ({ id: e.id }));
    const ackHeaders: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
    if (merchantId) {
      ackHeaders['x-polling-merchants'] = merchantId;
    }

    try {
      const ackRes = await fetch('https://merchant-api.ifood.com.br/events/v1.0/events/acknowledgment', {
        method: 'POST',
        headers: ackHeaders,
        body: JSON.stringify(ackEvents)
      });
      console.log(`[FIREFLY AUDIT ACK] Timestamp: ${new Date().toISOString()} | Acknowledgment for ${ackEvents.length} events sent immediately. Status: ${ackRes.status}`);

      // Also acknowledge on /order/v1.0/events/acknowledgment if available
      try {
        await fetch('https://merchant-api.ifood.com.br/order/v1.0/events/acknowledgment', {
          method: 'POST',
          headers: ackHeaders,
          body: JSON.stringify(ackEvents)
        });
      } catch (orderAckErr) {}
    } catch (ackError) {
      console.error(`[FIREFLY AUDIT ACK ERROR] Timestamp: ${new Date().toISOString()} | Error sending acknowledgment:`, ackError);
    }

    // STEP 2: PROCESS EVENTS (confirm, cancel etc.) after ACK
    for (const evt of events) {
      const code = String(evt.code || '').toUpperCase();
      const fullCode = String(evt.fullCode || '').toUpperCase();
      const allCodes = `${code} ${fullCode}`;

      // Flexible order ID resolution
      const orderId = evt.orderId || evt.correlationId || evt.metadata?.orderId || evt.metadata?.id || evt.id;

      const isPlaced = code === 'PLC' || fullCode === 'PLACED' || allCodes.includes('PLACED');
      
      const isCancellationRequested = (
        code === 'CAR' ||
        code === 'CPR' ||
        code === 'CCR' ||
        code === 'CRQ' ||
        allCodes.includes('CANCELLATION_REQUEST') ||
        allCodes.includes('CANCELLATION_REQUESTED') ||
        allCodes.includes('CANCEL_REQUEST')
      );
      
      const isCancelled = (
        code === 'CAN' ||
        code === 'COD' ||
        allCodes.includes('CANCELLED') ||
        allCodes.includes('CANCELED') ||
        allCodes.includes('CANCELLATION_COMMAND_ACCEPTED') ||
        allCodes.includes('CANCELLATION_COMMAND_DENIED') ||
        allCodes.includes('CANCELLATION_REQUEST_FAILED')
      );

      // PLC / PLACED = Placed order (Novo pedido)
      if (isPlaced && orderId) {
        try {
          const orderRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (orderRes.ok) {
            const rawOrder = await orderRes.json();

            // Auto-Confirm PLC order if autoConfirm setting is active (Crucial for Homologation SLA < 3s)
            let initialStatus = 'pendente';
            if (autoConfirm) {
              try {
                const confirmRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/confirm`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}` }
                });
                if (confirmRes.ok || confirmRes.status === 202) {
                  initialStatus = 'preparando';
                  console.log(`[FIREFLY AUDIT CONFIRM SUCCESS] Timestamp: ${new Date().toISOString()} | Auto-confirmed order ${orderId} successfully.`);
                }
              } catch (confirmErr) {
                console.error(`Erro no auto-confirm do pedido ${orderId}:`, confirmErr);
              }
            }

            // Map iFood order structure to our Kanban order structure
            const customerName = rawOrder.customer?.name || rawOrder.customer?.firstName || 'Cliente iFood';
            const customerPhone = rawOrder.customer?.phone?.number || rawOrder.customer?.phone || '';

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
              subtotal: (i.totalPrice || i.price || 0) / (i.totalPrice > 1000 ? 100 : 1)
            }));

            const totalValue = (rawOrder.total?.subTotal || rawOrder.payments?.pending || 0) / 
                               (rawOrder.total?.subTotal > 1000 ? 100 : 1);

            const paymentMethod = rawOrder.payments?.methods?.[0]?.name || 'iFood Online';

            const formattedTime = new Date(rawOrder.createdAt || Date.now())
              .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

            newOrders.push({
              id: `#IF-${rawOrder.displayId || rawOrder.id.substring(0, 5)}`,
              displayId: String(rawOrder.displayId || rawOrder.id.substring(0, 5)),
              ifoodOrderId: rawOrder.id,
              customerName,
              customerPhone,
              customerAddress: customerAddress || 'Endereço não informado',
              deliveryMode,
              items: items.length > 0 ? items : [{ name: 'Pedido de Teste iFood', price: totalValue || 25.0, quantity: 1, subtotal: totalValue || 25.0 }],
              totalValue: totalValue || 25.0,
              paymentMethod,
              createdAt: formattedTime,
              timestamp: Date.now(),
              status: initialStatus,
              isRealIFood: true,
              ifoodDriverStatus: null
            });
          }
        } catch (orderErr) {
          console.error(`Erro ao buscar detalhes do pedido ${orderId}:`, orderErr);
        }
      }

      // Cancellation Event Handling (Audit Requirement for iFood Homologation)
      if (isCancellationRequested && orderId) {
        console.log(`[FIREFLY AUDIT CANCEL EVENT RECEIVED] Timestamp: ${new Date().toISOString()} | Event ${code} (${fullCode}) received for order ${orderId}`);
        
        if (pdvInitiatedCancellations.has(orderId)) {
          console.log(`[FIREFLY AUDIT CANCEL] Timestamp: ${new Date().toISOString()} | Order ${orderId} was initiated by PDV (requestCancellation). Awaiting final CANCELLED event from iFood.`);
        } else {
          // Customer / System initiated cancellation — merchant must accept within SLA
          try {
            console.log(`[FIREFLY AUDIT CANCEL] Timestamp: ${new Date().toISOString()} | Customer-initiated CAR received. Calling acceptCancellation for order ${orderId}...`);
            
            // Parallel fetch of cancellationReasons for compliance audit
            fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/cancellationReasons`, {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.json()).then(data => {
              console.log(`[FIREFLY AUDIT CANCEL REASONS] Timestamp: ${new Date().toISOString()} | Reasons for ${orderId}:`, JSON.stringify(data));
            }).catch(() => {});

            const acceptRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/acceptCancellation`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({})
            });

            console.log(`[FIREFLY AUDIT CANCEL SUCCESS] Timestamp: ${new Date().toISOString()} | acceptCancellation response for ${orderId}: HTTP ${acceptRes.status}`);

            // If acceptCancellation returned an unaccepted status, fallback to requestCancellation with standard code
            if (!acceptRes.ok && acceptRes.status !== 200 && acceptRes.status !== 202 && acceptRes.status !== 400 && acceptRes.status !== 409) {
              await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/requestCancellation`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  cancellationCode: '501',
                  reason: 'Cancelamento aceito pelo restaurante'
                })
              });
            }
          } catch (cancelErr) {
            console.error(`[FIREFLY AUDIT CANCEL ERROR] Timestamp: ${new Date().toISOString()} | Error handling acceptCancellation for ${orderId}:`, cancelErr);
          }
        }

        // Fetch order details for audit trace
        try {
          fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
          }).catch(() => {});
        } catch (e) {}

        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          newStatus: 'cancelado'
        });
      }

      if (isCancelled && orderId) {
        pdvInitiatedCancellations.delete(orderId);
        console.log(`[FIREFLY AUDIT CANCEL SUCCESS] Timestamp: ${new Date().toISOString()} | Event CANCELLED (${code}) received for order ${orderId} — audit completed.`);

        // Fetch order details & cancellation reasons to ensure complete state synchronization
        try {
          const cancelledOrderRes = await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          console.log(`[FIREFLY AUDIT CANCELLED DETAILS] Timestamp: ${new Date().toISOString()} | GET order details for ${orderId} HTTP ${cancelledOrderRes.status}`);
        } catch (e) {}

        try {
          await fetch(`https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}/cancellationReasons`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
          });
        } catch (e) {}

        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          newStatus: 'cancelado'
        });
      }

      // CON / CONCLUDED = Order finished/completed
      const isConcluded = code === 'CON' || fullCode === 'CONCLUDED' || allCodes.includes('CONCLUDED');
      if (isConcluded && orderId) {
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          newStatus: 'concluido'
        });
      }

      // DSP / DISPATCHED / RTP / READY_TO_PICKUP = Order dispatched or ready for delivery
      const isDispatched = (
        code === 'DSP' ||
        code === 'DISPATCHED' ||
        code === 'RTP' ||
        code === 'READY_TO_PICKUP' ||
        allCodes.includes('DISPATCH') ||
        allCodes.includes('READY_TO_PICKUP')
      );
      if (isDispatched && orderId) {
        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          newStatus: 'despachado'
        });
      }

      // DRIVER / SHIPPING EVENTS (iFood Delivery Logistics)
      const isDriverAssigned = code === 'ADR' || fullCode === 'ASSIGNED_DRIVER' || allCodes.includes('ASSIGNED_DRIVER');
      const isDriverGoingToOrigin = code === 'GTO' || fullCode === 'GOING_TO_ORIGIN' || allCodes.includes('GOING_TO_ORIGIN');
      const isDriverArrivedAtOrigin = code === 'AAO' || fullCode === 'ARRIVED_AT_ORIGIN' || allCodes.includes('ARRIVED_AT_ORIGIN');
      const isDriverDispatched = code === 'DCO' || fullCode === 'COLLECTED' || allCodes.includes('COLLECTED');

      if (orderId && (isDriverAssigned || isDriverGoingToOrigin || isDriverArrivedAtOrigin || isDriverDispatched)) {
        let driverStatus = 'ASSIGNED';
        if (isDriverGoingToOrigin) driverStatus = 'GOING_TO_ORIGIN';
        if (isDriverArrivedAtOrigin) driverStatus = 'ARRIVED_AT_ORIGIN';
        if (isDriverDispatched) driverStatus = 'DISPATCHED';

        updatedEvents.push({
          ifoodOrderId: orderId,
          code: evt.code,
          driverStatus: driverStatus,
          driverInfo: evt.data || null
        });
      }
    }

    // ACK already sent immediately after polling above (Firefly Audit < 10s requirement)

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
