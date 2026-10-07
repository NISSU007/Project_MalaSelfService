const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { dbAll, dbGet, dbRun } = require('../config/db');
const {
  STATUS, SPICE_LEVELS, PAYMENT_TIMEOUT_MIN, notifyCount,
  groupOf, getTable, getCart, getOrCreateCart, getOrderItems,
  recalcTotal, getOrderFull, makeReferenceCode
} = require('../utils/helpers');

// จำนวนสูงสุดต่อรายการที่สั่งได้ในครั้งเดียว
const MAX_QTY = 20;

// SELECT เมนู + เช็คสต็อกจากตาราง Inventory
const MENU_SELECT = `
  SELECT m.*, c.Category_Name,
         i.In_Stock_Quantity AS Stock_Left,
         CASE WHEN m.Ingredient_ID IS NOT NULL
                   AND i.In_Stock_Quantity < IFNULL(m.Serving_Qty, 0)
              THEN 1 ELSE 0 END AS OutOfStock
  FROM Menu m
  LEFT JOIN Category c ON m.Category_ID = c.Category_ID
  LEFT JOIN Inventory i ON m.Ingredient_ID = i.Ingredient_ID`;

function isSoldOut(m) {
  return m.Is_Available === 0 || m.OutOfStock === 1;
}

function isStockError(err) {
  return !!(err && err.message && err.message.indexOf('In_Stock_Quantity') !== -1);
}

function ownsOrder(table, order) {
  return !!(table && order && String(order.Table_ID) === String(table.Table_ID));
}

// Middleware บันทึก Table_ID ลงใน Session
router.use('/table/:tableId', (req, res, next) => {
  if (req.params.tableId) {
    req.session.tableId = req.params.tableId;
  }
  next();
});

// UC01: แสดงรายการอาหาร
router.get('/table/:tableId', (req, res) => {
  res.redirect('/table/' + req.params.tableId + '/menu');
});

router.get('/table/:tableId/menu', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะนี้ กรุณาสแกน QR Code ใหม่');

    const tab = req.query.tab || 'all';
    const categories = await dbAll('SELECT * FROM Category ORDER BY Category_ID');
    categories.forEach((c) => (c.group = groupOf(c.Category_Name)));

    const menus = await dbAll(MENU_SELECT + ' ORDER BY m.Category_ID, m.Menu_ID');
    menus.forEach((m) => {
      m.group = groupOf(m.Category_Name);
      m.soldOut = isSoldOut(m);
    });

    const rawCats = categories.filter((c) => c.group === 'raw');
    const selectedCat = Number(req.query.cat) || (rawCats[0] ? rawCats[0].Category_ID : 0);

    const cart = await getCart(table.Table_ID);
    let cartCount = 0;
    let cartTotal = 0;
    if (cart) {
      const s = await dbGet(
        'SELECT IFNULL(SUM(Quantity),0) AS qty, IFNULL(SUM(Subtotal),0) AS total FROM Order_Detail WHERE Order_ID = ?',
        [cart.Order_ID]
      );
      cartCount = s.qty;
      cartTotal = s.total;
    }

    res.render('customer/menu', {
      table, tab, categories, rawCats, selectedCat, menus,
      cartCount, cartTotal,
      added: req.query.added,
      error: req.query.error
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC02: เลือกและปรับแต่งรายการอาหาร
router.get('/table/:tableId/item/:menuId', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const menu = await dbGet(MENU_SELECT + ' WHERE m.Menu_ID = ?', [req.params.menuId]);
    if (!table || !menu) return res.status(404).send('ไม่พบรายการ');
    menu.soldOut = isSoldOut(menu);
    menu.isSoup = menu.Category_Name === 'ซุป';

    let editItem = null;
    if (req.query.edit) {
      const cart = await getCart(table.Table_ID);
      if (cart) {
        editItem = await dbGet('SELECT * FROM Order_Detail WHERE Order_Detail_ID = ? AND Order_ID = ?',
          [req.query.edit, cart.Order_ID]);
      }
    }

    res.render('customer/item', {
      table, menu, editItem,
      spiceLevels: SPICE_LEVELS,
      error: req.query.error,
      backTab: groupOf(menu.Category_Name)
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/cart/add', async (req, res) => {
  const tableId = req.params.tableId;
  let backURL = '/table/' + tableId + '/menu';
  try {
    const { menuId, spice, note, detailId, soup1, soup2 } = req.body;
    const qty = Math.min(MAX_QTY, Math.max(1, parseInt(req.body.qty, 10) || 1));
    const menu = await dbGet(MENU_SELECT + ' WHERE m.Menu_ID = ?', [menuId]);
    if (!menu) return res.redirect('/table/' + tableId + '/menu');

    backURL = '/table/' + tableId + '/item/' + menuId + (detailId ? '?edit=' + detailId + '&' : '?');

    if (isSoldOut(menu)) {
      return res.redirect(backURL + 'error=soldout');
    }

    const isSoup = menu.Category_Name === 'ซุป';
    if (isSoup && !SPICE_LEVELS.includes(spice)) {
      return res.redirect(backURL + 'error=spice');
    }

    const isTwoSoups = isSoup && menu.Menu_Name.includes('2');
    if (isTwoSoups && (!soup1 || !soup2)) {
      return res.redirect(backURL + 'error=soup');
    }
    
    if (isTwoSoups && (soup1 === soup2)) {
      return res.redirect(backURL + 'error=samesoup');
    }

    const spiceValue = isSoup ? spice : null;
    let soupValue = isSoup ? menu.Menu_Name : null;
    
    if (isTwoSoups) {
      soupValue = soup1 + ' + ' + soup2;
    }

    const noteValue = (note || '').trim();
    const finalQty = isSoup ? 1 : qty;

    const cart = await getOrCreateCart(tableId);

    if (detailId) {
      await dbRun(
        `UPDATE Order_Detail SET Quantity = ?, Unit_Price = ?, Spiciness_Level = ?, Soup_Type = ?, Special_Note = ?
         WHERE Order_Detail_ID = ? AND Order_ID = ?`,
        [finalQty, menu.Price, spiceValue, soupValue, noteValue, detailId, cart.Order_ID]
      );
      await recalcTotal(cart.Order_ID);
      return res.redirect('/table/' + tableId + '/cart');
    }

    const same = await dbGet(
      `SELECT * FROM Order_Detail WHERE Order_ID = ? AND Menu_ID = ?
       AND IFNULL(Spiciness_Level,'') = ? AND IFNULL(Special_Note,'') = ?`,
      [cart.Order_ID, menu.Menu_ID, spiceValue || '', noteValue]
    );

    if (same && !isSoup) {
      const newQty = Math.min(MAX_QTY, same.Quantity + finalQty);
      await dbRun('UPDATE Order_Detail SET Quantity = ? WHERE Order_Detail_ID = ?',
        [newQty, same.Order_Detail_ID]);
    } else {
      await dbRun(
        `INSERT INTO Order_Detail (Order_ID, Menu_ID, Quantity, Unit_Price, Spiciness_Level, Soup_Type, Special_Note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cart.Order_ID, menu.Menu_ID, finalQty, menu.Price, spiceValue, soupValue, noteValue]
      );
    }
    await recalcTotal(cart.Order_ID);
    res.redirect('/table/' + tableId + '/menu?tab=' + groupOf(menu.Category_Name) + '&cat=' + menu.Category_ID + '&added=' + encodeURIComponent(menu.Menu_Name));
  } catch (err) {
    if (isStockError(err)) return res.redirect(backURL + 'error=soldout');
    res.status(500).send(err.message);
  }
});

// UC03: แก้ไขรายการอาหารในตะกร้า
router.get('/table/:tableId/cart', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะ');
    const cart = await getCart(table.Table_ID);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    const total = items.reduce((sum, it) => sum + it.Subtotal, 0);

    const hasIngredient = items.some(it => groupOf(it.Category_Name) === 'raw' || it.Category_Name === 'วัตถุดิบ');
    const hasSoup = items.some(it => groupOf(it.Category_Name) === 'soup' || it.Category_Name === 'ซุป' || !!it.Soup_Type);
    const missingSoup = hasIngredient && !hasSoup;

    res.render('customer/cart', { table, cart, items, total, missingSoup, error: req.query.error });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/cart/update/:detailId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    if (!cart) return res.redirect('/table/' + tableId + '/cart');
    const item = await dbGet('SELECT * FROM Order_Detail WHERE Order_Detail_ID = ? AND Order_ID = ?',
      [req.params.detailId, cart.Order_ID]);
    if (item) {
      if (item.Soup_Type) {
        return res.redirect('/table/' + tableId + '/cart?error=soupqty');
      }
      const newQty = req.body.action === 'plus' ? item.Quantity + 1 : item.Quantity - 1;
      if (newQty <= 0) {
        await dbRun('DELETE FROM Order_Detail WHERE Order_Detail_ID = ?', [item.Order_Detail_ID]);
      } else if (newQty <= MAX_QTY) {
        await dbRun('UPDATE Order_Detail SET Quantity = ? WHERE Order_Detail_ID = ?',
          [newQty, item.Order_Detail_ID]);
      }
      await recalcTotal(cart.Order_ID);
    }
    res.redirect('/table/' + tableId + '/cart');
  } catch (err) {
    if (isStockError(err)) return res.redirect('/table/' + tableId + '/cart?error=stock');
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/cart/delete/:detailId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    if (cart) {
      await dbRun('DELETE FROM Order_Detail WHERE Order_Detail_ID = ? AND Order_ID = ?',
        [req.params.detailId, cart.Order_ID]);
      await recalcTotal(cart.Order_ID);
    }
    res.redirect('/table/' + tableId + '/cart');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC04: ยืนยันคำสั่งซื้อ
router.post('/table/:tableId/cart/confirm', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + tableId + '/cart?error=empty');

    const hasIngredient = items.some(it => groupOf(it.Category_Name) === 'raw' || it.Category_Name === 'วัตถุดิบ');
    const hasSoup = items.some(it => groupOf(it.Category_Name) === 'soup' || it.Category_Name === 'ซุป' || !!it.Soup_Type);
    
    if (hasIngredient && !hasSoup) {
      return res.redirect('/table/' + tableId + '/cart?error=nosoup');
    }

    res.redirect('/table/' + tableId + '/summary');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get('/table/:tableId/summary', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะ');
    const cart = await getCart(table.Table_ID);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + req.params.tableId + '/cart?error=empty');
    const total = items.reduce((sum, it) => sum + it.Subtotal, 0);
    res.render('customer/summary', { table, cart, items, total });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/checkout', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const table = await getTable(tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะ');
    const cart = await getCart(tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + tableId + '/cart?error=empty');

    const ref = await makeReferenceCode(table);
    await recalcTotal(cart.Order_ID);
    await dbRun(
      'UPDATE "Order" SET Order_Status = ?, Reference_Code = ?, Order_Date_Time = CURRENT_TIMESTAMP WHERE Order_ID = ?',
      [STATUS.WAIT_PAY, ref, cart.Order_ID]
    );
    await dbRun('UPDATE "Table" SET Table_Status = ? WHERE Table_ID = ?', ['มีลูกค้า', table.Table_ID]);

    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [cart.Order_ID]);
    if (!pay) {
      // ✅ แก้ไขปัญหา SQLITE_CONSTRAINT ทะลุ CHECK("Payment_Method" IN ('QR Code', 'เงินสด'))
      // เปลี่ยนจาก 'ยังไม่เลือก' เป็น 'เงินสด' เพื่อให้ DB บันทึกได้ แล้วลูกค้าค่อยไปเปลี่ยนวิธีในหน้า payment
      await dbRun(
        'INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status) VALUES (?, ?, ?, ?, ?)',
        [cart.Order_ID, 'เงินสด', 0, 0, 'รอชำระ']
      );
    }

    res.redirect('/table/' + tableId + '/payment/' + cart.Order_ID);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC05: เลือกช่องทางการชำระเงิน และชำระเงิน
async function expireOrder(order) {
  const cart = await getCart(order.Table_ID);
  if (cart) {
    await dbRun('UPDATE Order_Detail SET Order_ID = ? WHERE Order_ID = ?', [cart.Order_ID, order.Order_ID]);
    await dbRun('DELETE FROM "Order" WHERE Order_ID = ?', [order.Order_ID]);
    await recalcTotal(cart.Order_ID);
  } else {
    await dbRun('UPDATE "Order" SET Order_Status = ?, Reference_Code = NULL WHERE Order_ID = ?',
      [STATUS.CART, order.Order_ID]);
  }
}

router.get('/table/:tableId/payment/:orderId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const table = await getTable(tableId);
    const order = await getOrderFull(req.params.orderId);
    if (!ownsOrder(table, order)) return res.redirect('/table/' + tableId + '/menu');

    if (order.Order_Status !== STATUS.WAIT_PAY) {
      return res.redirect('/table/' + tableId + '/order/' + order.Order_ID);
    }

    const age = await dbGet(
      "SELECT (julianday('now') - julianday(Order_Date_Time)) * 86400 AS sec FROM \"Order\" WHERE Order_ID = ?",
      [order.Order_ID]
    );
    const secondsLeft = Math.max(0, Math.floor(PAYMENT_TIMEOUT_MIN * 60 - age.sec));

    if (!order.Payment_ID && secondsLeft <= 0) {
      await expireOrder(order);
      return res.redirect('/table/' + tableId + '/cart?error=expired');
    }

    // เปิดให้ค่า method รอรับจาก req.query โดยไม่ต้อง fallback กลับไปที่ 'cash'
    let method = req.query.method || null;

    let qrImage = null;
    if (method === 'qr') {
      const payload = 'MALA-PAY|REF:' + order.Reference_Code + '|AMOUNT:' + order.Total_Price;
      qrImage = await QRCode.toDataURL(payload, { width: 260, margin: 1 });
    }

    res.render('customer/payment', { table, order, method, qrImage, secondsLeft, hasPayment: !!order.Payment_ID });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/payment/:orderId/cash', async (req, res) => {
  const { tableId, orderId } = req.params;
  try {
    const table = await getTable(tableId);
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    if (!ownsOrder(table, order)) return res.redirect('/table/' + tableId + '/menu');
    if (order.Order_Status !== STATUS.WAIT_PAY) return res.redirect('/table/' + tableId + '/order/' + orderId);

    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!pay) {
      await dbRun(
        'INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status) VALUES (?, ?, ?, ?, ?)',
        [orderId, 'เงินสด', 0, 0, 'รอชำระ']
      );
    } else {
      await dbRun('UPDATE Payment SET Payment_Method = ?, Payment_Status = ? WHERE Order_ID = ?', ['เงินสด', 'รอชำระ', orderId]);
    }
    res.redirect('/table/' + tableId + '/payment/' + orderId + '?method=cash');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/payment/:orderId/qr', async (req, res) => {
  const { tableId, orderId } = req.params;
  try {
    const table = await getTable(tableId);
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    if (!ownsOrder(table, order)) return res.redirect('/table/' + tableId + '/menu');
    if (order.Order_Status !== STATUS.WAIT_PAY) return res.redirect('/table/' + tableId + '/order/' + orderId);

    const txn = 'TXN' + Date.now();
    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!pay) {
      await dbRun(
        `INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status, Payment_Date_Time, Transaction_Ref)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [orderId, 'QR Code', order.Total_Price, 0, 'ชำระแล้ว', txn]
      );
    } else {
      await dbRun(
        `UPDATE Payment SET Payment_Method = ?, Payment_Amount = ?, Change_Amount = 0, Payment_Status = ?,
         Transaction_Ref = ?, Payment_Date_Time = CURRENT_TIMESTAMP WHERE Order_ID = ?`,
        ['QR Code', order.Total_Price, 'ชำระแล้ว', txn, orderId]
      );
    }
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.PREPARING, orderId, STATUS.WAIT_PAY]);
    res.redirect('/table/' + tableId + '/order/' + orderId);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC07: ติดตามสถานะคำสั่งซื้อ และแสดงรายละเอียดออเดอร์
router.get('/table/:tableId/order/:orderId', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const order = await getOrderFull(req.params.orderId);
    if (!ownsOrder(table, order) || order.Order_Status === STATUS.CART) {
      return res.redirect('/table/' + req.params.tableId + '/menu');
    }
    res.render('customer/order', { table, order, notify: notifyCount[order.Order_ID] || 0 });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get('/api/order/:orderId', async (req, res) => {
  try {
    const order = await dbGet('SELECT Order_ID, Order_Status FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    if (!order) return res.json({ ok: false });
    res.json({ ok: true, status: order.Order_Status, notify: notifyCount[order.Order_ID] || 0 });
  } catch (err) {
    res.json({ ok: false });
  }
});

module.exports = router;