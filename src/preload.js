const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('a8',{
 open:()=>ipcRenderer.invoke('open-a8'),run:()=>ipcRenderer.invoke('run-all'),save:()=>ipcRenderer.invoke('save-csv'),
 onProgress:fn=>ipcRenderer.on('progress',(_event,p)=>fn(p))
});
