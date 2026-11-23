document.querySelector('.browser-help')?.remove();
const taskForm=document.querySelector('#task-form');
const description=document.querySelector('#tasks .section-head p:last-child');
description.textContent='保存栏目和采集数量后即可执行。定时任务每 15 秒检查一次；请保持本地服务运行、电脑唤醒。';
const limitInput=document.createElement('input');limitInput.name='limit';limitInput.type='number';limitInput.min=1;limitInput.max=30;limitInput.value=5;limitInput.title='每次采集数量（1—30）';taskForm.insertBefore(limitInput,taskForm.lastElementChild);
taskForm.style.gridTemplateColumns='1fr';
document.querySelector('#customs-categories').addEventListener('click',e=>{
  if(!e.target.dataset.categoryUrl)return;
  taskForm.elements.name.value=e.target.textContent;
  taskForm.elements.url.value=e.target.dataset.categoryUrl;
  toast('栏目已填入定时任务配置，可前往保存并执行');
});
const oldRender=render;
render=()=>{oldRender();document.querySelectorAll('.task-card').forEach((el,i)=>{
 const task=state.tasks[i], controls=document.createElement('div');controls.style.cssText='display:grid;gap:8px;min-width:100px';
 const edit=document.createElement('button');edit.textContent='修改配置';edit.onclick=()=>{taskForm.dataset.editId=task.id;for(const k of ['name','url','frequency','limit'])taskForm.elements[k].value=task[k]||5;taskForm.lastElementChild.textContent='保存配置';taskForm.scrollIntoView({behavior:'smooth'});};controls.append(edit);
 for(const [label,action] of [['立即执行','run'],[task.enabled===false?'启用定时':'暂停定时','toggle']]){
 const b=document.createElement('button');b.textContent=label;b.style.padding='9px';b.onclick=async()=>{try{await api(`/api/tasks/${task.id}/${action}`,{method:'POST',body:{}});toast(action==='run'?'采集已启动':'配置已更新');await refresh();}catch(e){toast(e.message)}};controls.append(b);}
 el.append(controls);
 const logs=document.createElement('pre');logs.style.cssText='white-space:pre-wrap;font-size:12px;line-height:1.8';logs.textContent=(task.log||[]).join('\n') || '尚未运行';el.firstElementChild.append(logs);
 });};
setInterval(()=>refresh().catch(()=>{}),3000);
taskForm.onsubmit=async e=>{e.preventDefault();const id=taskForm.dataset.editId;try{await api(id?'/api/tasks/'+id:'/api/tasks',{method:id?'PUT':'POST',body:Object.fromEntries(new FormData(taskForm))});delete taskForm.dataset.editId;taskForm.reset();taskForm.lastElementChild.textContent='创建任务';await refresh();toast('配置已保存');}catch(e){toast(e.message)}};
refresh();
