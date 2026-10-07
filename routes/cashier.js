const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../config/db');
const { STATUS, getOrderFull, getEmployee } = require('../utils/helpers');

router.get('/cashier', async (req, res) => {
  try {
    const tab = req.query.tab || 'all';
    const q = (req.query.q || '').trim();

    let sql = `SELECT o.*, t.Table_Number,
         COALESCE(p.Payment_Method, 'เงินสด') AS Payment_Method,
         COALESCE(p.Payment_Status, CASE WHEN o.Order_Status = '${STATUS.WAIT_PAY}' THEN 'รอชำระ' ELSE 'ชำระแล้ว' END) AS Payment_Status,
         p.Payment_Amount, p.Change_Amount, p.Transaction_Ref,
         strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time,
         (SELECT COUNT(*) FROM Order_Detail d WHERE d.Order_ID = o.Order_ID) AS Item_Count
       FROM "Order" o
       LEFT JOIN Payment p ON p.Order_ID = o.Order_ID
       LEFT JOIN "Table" t ON o.Table_ID = t.Table_ID
       WHERE date(o.Order_Date_Time, 'localtime') = date('now', 'localtime')
         AND o.Order_Status != '${STATUS.CART}'`;
    
    const params = [];
    if (q) {
      sql += ` AND REPLACE(o.Reference_Code, '-', '') LIKE ?`;
      params.push('%' + q.replace('-', '') + '%');
    }
    
    // เรียงลำดับตามเวลาใหม่สุดขึ้นก่อนเสมอ (เอาการเรียงตามสถานะออก)
    sql += ` ORDER BY o.Order_Date_Time DESC`;
    
    const all = await dbAll(sql, params);

    const pending = all.filter((o) => o.Payment_Status === 'รอชำระ' || o.Order_Status === STATUS.WAIT_PAY);
    const paid = all.filter((o) => o.Payment_Status === 'ชำระแล้ว' && o.Order_Status !== STATUS.WAIT_PAY);
    const list = tab === 'pending' ? pending : tab === 'paid' ? paid : all;

    let selected = null;
    if (req.query.id) selected = await getOrderFull(req.query.id);

    const employee = await getEmployee('แคชเชียร์');
    res.render('cashier/index', {
      tab, q, list, selected, employee,
      counts: { all: all.length, pending: pending.length, paid: paid.length },
      error: req.query.error,
      success: req.query.success
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/cashier/pay/:orderId', async (req, res) => {
  const orderId = req.params.orderId;
  try {
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    let pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!order || order.Order_Status !== STATUS.WAIT_PAY) {
      return res.redirect('/cashier?id=' + orderId);
    }

    const received = parseFloat(req.body.received);
    if (isNaN(received) || received < order.Total_Price) {
      return res.redirect('/cashier?tab=pending&id=' + orderId + '&error=notenough');
    }
    const change = received - order.Total_Price;

    // ถ้ายังไม่มีแถว Payment ให้สร้างใหม่ ถ้ามีแล้วให้ UPDATE
    if (!pay) {
      await dbRun(
        `INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status, Payment_Date_Time, Transaction_Ref)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [orderId, 'เงินสด', received, change, 'ชำระแล้ว', 'CASH' + Date.now()]
      );
    } else {
      await dbRun(
        `UPDATE Payment SET Payment_Method = ?, Payment_Amount = ?, Change_Amount = ?, Payment_Status = ?,
         Payment_Date_Time = CURRENT_TIMESTAMP, Transaction_Ref = ? WHERE Order_ID = ?`,
        ['เงินสด', received, change, 'ชำระแล้ว', 'CASH' + Date.now(), orderId]
      );
    }

    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.PREPARING, orderId, STATUS.WAIT_PAY]);

    res.redirect('/cashier?tab=all&id=' + orderId + '&success=1');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;