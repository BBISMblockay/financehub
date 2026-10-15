'use strict';

const fs = require('fs');
const path = require('path');
const { startSuite } = require('../lib/harness');

const OUT = process.env.TM_UX_SCREENSHOT_DIR || '/opt/cursor/artifacts/screenshots';
const USER = 'test-user';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LAUNCH = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

const PROFILES = [
  { id: USER, name: 'Alex Rivera', email: 'test@baseballism.com', avatar_url: null, is_active: true, role: 'admin' },
  { id: OTHER, name: 'Jordan Lee', email: 'jordan@baseballism.com', avatar_url: null, is_active: true, role: 'admin' },
];
const LAUNCHES = [{ id: LAUNCH, title: 'Spring Drop 2026', launch_date: day(10) }];
const TASKS = [
  { id: 't1', task_title: 'Finalize hero email copy', task_type: 'Email', status: 'in-progress', priority: 'high',
    due_date: day(-2), estimated_minutes: 60, assigned_to_user_id: USER, assigned_to_name: 'Alex Rivera',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 1, notes: 'Brief by Friday.' },
  { id: 't2', task_title: 'Upload PDP lifestyle shots', task_type: 'Creative', status: 'open', priority: 'critical',
    due_date: day(2), estimated_minutes: 120, assigned_to_user_id: USER, assigned_to_name: 'Alex Rivera',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 2, notes: null },
  { id: 't3', task_title: 'Reconcile launch inventory', task_type: 'Ops', status: 'open', priority: 'normal',
    due_date: day(4), estimated_minutes: 30, assigned_to_user_id: OTHER, assigned_to_name: 'Jordan Lee',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 1, notes: null },
  { id: 't4', task_title: 'Refresh TikTok bio link', task_type: 'Social', status: 'open', priority: 'low',
    due_date: null, estimated_minutes: 15, assigned_to_user_id: null, assigned_to_name: null,
    launch_id: null, channel_item_id: null, is_private: false, sort_order: 1, notes: null },
  { id: 't5', task_title: 'Ship lookbook PDF', task_type: 'Creative', status: 'done', priority: 'normal',
    due_date: day(-5), estimated_minutes: 60, assigned_to_user_id: OTHER, assigned_to_name: 'Jordan Lee',
    launch_id: LAUNCH, channel_item_id: null, is_private: false, sort_order: 1, notes: null },
];

async function snap(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved ' + file);
}

(async () => {
  const suite = await startSuite({ viewport: { width: 1500, height: 900 } });
  try {
    const page = await suite.open('/v2/tasks.html', {
      launch_tasks: TASKS,
      launch_calendar: LAUNCHES,
      launch_channel_items: [],
      profiles: PROFILES,
    }, {
      ready: () => {
        const tb = document.getElementById('tasksTbody');
        return tb && !/Loading/.test(tb.textContent);
      },
    });
    await page.waitForTimeout(350);
    await snap(page, 'task_manager_table_view.png');

    await page.click('[data-display="board"]');
    await page.waitForTimeout(300);
    await snap(page, 'task_manager_kanban_board.png');

    await page.click('[data-display="calendar"]');
    await page.waitForTimeout(300);
    await snap(page, 'task_manager_calendar_view.png');
  } finally {
    await suite.close();
  }
})();
