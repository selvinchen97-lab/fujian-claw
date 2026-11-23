const [command]=process.argv.slice(2);
const base='http://127.0.0.1:4310';
try {
  if(command && command!=='list') throw Error('当前为人工确认模式。请通过工作台预览正文后点击“确认抓取正文”。');
  const response=await fetch(base+'/api/state');
  const data=await response.json();console.log(JSON.stringify(command==='list'?data.tasks:data,null,2));if(!response.ok)process.exitCode=1;
}catch(e){console.error('请先运行 npm start：'+e.message);process.exitCode=1;}
