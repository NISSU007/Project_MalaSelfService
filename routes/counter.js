const express = require('express');
const router = express.Router();
const { dbGet, dbRun } = require('../config/db');
const { STATUS, notifyCount, orderNo, getOrderFull, getOrdersByStatus, getEmployee } = require('../utils/helpers');

// UC10: แสดงออเดอร์ที่เคาน์เตอร์ (เพิ่มระบบ Tab Filter & Search)
router.get('/counter', async (req, res) => {
  try {
    const tab = req.query.tab || 'cooked'; // ค่าเริ่มต้นแสดงออเดอร์ที่ปรุงเสร็จแล้ว
    const q = (req.query.q || '').trim();

    // ดึงข้อมูลแต่ละสถานะพร้อมการค้นหา
    const preparing = await getOrdersByStatus([STATUS.PREPARING], q);
    const cooked = await getOrdersByStatus([STATUS.COOKED], q);
    const ready = await getOrdersByStatus([STATUS.READY], q);

    // ดึงจำนวนออเดอร์ที่เสร็จสิ้นของวันนี้
    const doneToday = await dbGet(
      `SELECT COUNT(*) AS n FROM "Order" WHERE Order_Status IN (?, ?)
       AND date(Order_Date_Time, 'localtime') = date('now', 'localtime')`,
      [STATUS.READY, STATUS.DONE]
    );

    // เลือกลิสต์ข้อมูลตามแท็บที่เลือก
    let list = cooked;
    if (tab === 'preparing') list = preparing;
    if (tab === 'cooked') list = cooked;
    if (tab === 'ready') list = ready;

    if (tab === 'done') {
      const allDone = await getOrdersByStatus([STATUS.READY, STATUS.DONE], q);
      const todayOrders = await dbGet(
        `SELECT GROUP_CONCAT(Order_ID) AS ids FROM "Order" 
         WHERE Order_Status IN (?, ?) 
         AND date(Order_Date_Time, 'localtime') = date('now', 'localtime')`,
        [STATUS.READY, STATUS.DONE]
      );
      const todayIds = todayOrders && todayOrders.ids ? todayOrders.ids.split(',').map(String) : [];
      list = allDone.filter(o => todayIds.includes(String(o.Order_ID)));
    }

    let selected = null;
    if (req.query.id) selected = await getOrderFull(req.query.id);

    const employee = await getEmployee('หน้าเคาน์เตอร์');

    res.render('counter/index', {
      tab,
      q,
      list,
      selected,
      employee,
      counts: {
        preparing: preparing.length,
        cooked: cooked.length,
        ready: ready.length,
        done: doneToday.n
      },
      page: 'ready'
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC09: อัปเดตสถานะออเดอร์ (พร้อมเสิร์ฟ)
router.get('/counter/status', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.COOKED]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/status', {
      list,
      selected,
      employee,
      counts: { cooked: list.length, ready: 0 },
      page: 'status',
      success: req.query.success
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/counter/status/:orderId', async (req, res) => {
  try {
    const r = await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.READY, req.params.orderId, STATUS.COOKED]);
    if (r.changes > 0) notifyCount[req.params.orderId] = 1;
    const o = await dbGet('SELECT Reference_Code FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    res.redirect('/counter/status?success=' + encodeURIComponent(orderNo(o ? o.Reference_Code : '')));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC11: แจ้งเตือนและยืนยันการรับอาหาร
router.get('/counter/notify', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.READY]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    if (selected) selected.notify = notifyCount[selected.Order_ID] || 0;
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/notify', {
      list,
      selected,
      employee,
      counts: { cooked: 0, ready: list.length },
      page: 'notify',
      message: req.query.message
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/counter/notify/:orderId', (req, res) => {
  const id = req.params.orderId;
  notifyCount[id] = (notifyCount[id] || 0) + 1;
  res.redirect('/counter/notify?id=' + id + '&message=renotify');
});

router.post('/counter/complete/:orderId', async (req, res) => {
  try {
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.DONE, req.params.orderId, STATUS.READY]);
    delete notifyCount[req.params.orderId];
    res.redirect('/counter/notify?message=done');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;