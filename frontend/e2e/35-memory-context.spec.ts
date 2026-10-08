import { test, expect } from './fixtures';

test('35. complete scoped memory can be edited with a preserved original', async ({page, api}, testInfo) => {
  const title=`发布规则-${Date.now()}`;
  const content='完整规则内容'.repeat(600)+'末尾约束';
  await page.goto('/memory');
  await page.getByRole('button',{name:'新建',exact:true}).click();
  await page.getByLabel('记忆分类',{exact:true}).selectOption('core_rule');
  await page.getByLabel('记忆标题',{exact:true}).fill(title);
  await page.getByLabel('记忆内容',{exact:true}).fill(content);
  const saved=page.waitForResponse(r=>r.url().endsWith('/memory/write')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  const original=(await (await saved).json()).memory_id;
  const read=await api.get(`/api/memory/${original}?workspace_id=default`);
  expect((await read.json()).record.content).toBe(content);
  await page.getByRole('button',{name:title,exact:true}).click();
  await expect(page.locator('.memory-card-detail pre').first()).toContainText('末尾约束');
  await page.getByRole('button',{name:'修改记忆',exact:true}).click();
  await page.getByLabel('记忆内容',{exact:true}).fill('以后不要自动推送提交，请先核对结果。');
  const revised=page.waitForResponse(r=>r.url().endsWith('/memory/write')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  const replacement=(await (await revised).json()).memory_id;
  expect(replacement).not.toBe(original);
  const old=(await (await api.get(`/api/memory/${original}?workspace_id=default`)).json()).record;
  expect(old.status).toBe('expired'); expect(old.content).toBe(content);
  await page.getByRole('checkbox',{name:'显示历史'}).check();
  await expect(page.getByRole('button',{name:title,exact:true})).toHaveCount(2);
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('memory-revision-mobile.png'),fullPage:true});
});

test('35. user-scoped preferences and project memory have distinct visibility', async ({page, api}) => {
  const name=`个人偏好-${Date.now()}`;
  const personal=await api.post('/api/memory/write',{data:{workspace_id:'default',title:name,content:'个人通用偏好：回答使用中文。',scope:'global',memory_type:'core_rule',user_confirmed:true}});
  expect(personal.ok()).toBeTruthy(); const id=(await personal.json()).memory_id;
  const project=await api.post('/api/memory/write',{data:{workspace_id:'default',title:name+'项目',content:'本项目专用资料，不跨项目引用。',scope:'workspace',user_confirmed:true}});
  const projectId=(await project.json()).memory_id;
  expect((await api.get(`/api/memory/${id}?workspace_id=another-project`)).ok()).toBeTruthy();
  expect((await api.get(`/api/memory/${projectId}?workspace_id=another-project`)).status()).toBe(404);
  await page.goto('/memory');
  await page.getByLabel('筛选范围').selectOption('global');
  await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:name+'项目',exact:true})).toHaveCount(0);
});

test('35. a generated replacement stays pending until explicit review', async ({page, api}, testInfo) => {
  const name=`审核规则-${Date.now()}`;
  const original=(await (await api.post('/api/memory/write',{data:{workspace_id:'default',title:name,content:'原规则完整内容：提交前核对结果。',memory_type:'core_rule',user_confirmed:true}})).json()).memory_id;
  const candidate=(await (await api.post('/api/memory/write',{data:{workspace_id:'default',title:name+'候选',content:'新规则完整内容：发布前核对全部附件。',memory_type:'core_rule',supersedes_memory_id:original}})).json()).memory_id;
  expect((await (await api.get(`/api/memory/${original}?workspace_id=default`)).json()).record.status).toBe('active');
  await page.goto('/memory');
  await page.getByLabel('筛选状态').selectOption('conflict');
  await page.getByRole('button',{name:name+'候选',exact:true}).click();
  await expect(page.getByText('替换原记录：'+original,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'确认并启用',exact:true}).click();
  await expect(page.getByText('记忆已确认并开始生效',{exact:true})).toBeVisible();
  expect((await (await api.get(`/api/memory/${original}?workspace_id=default`)).json()).record.status).toBe('expired');
  expect((await (await api.get(`/api/memory/${candidate}?workspace_id=default`)).json()).record.status).toBe('active');
  await page.getByLabel('筛选状态').selectOption('active');
  await page.screenshot({path:testInfo.outputPath('memory-reviewed.png'),fullPage:true});
});
