const fs=require('fs');
const path='app/globals.css';
let css=fs.readFileSync(path,'utf8');
css=css.replace(/\.mapstage\{position:absolute!important;/,'.mapstage{position:absolute!important;z-index:11!important;');
css=css.replace(/\.citizen span\{width:16px!important;height:16px!important;border-width:2px!important;box-shadow:0 0 0 3px #0b1b10aa,0 0 13px #8bf16b88!important\}/,'.citizen span{width:16px!important;height:16px!important;border-width:2px!important;box-shadow:0 0 0 3px #0b1b10aa,0 0 13px #8bf16b88!important;animation:citizen-bob .42s ease-in-out infinite alternate}');
if(!css.includes('@keyframes citizen-bob')) css += '@keyframes citizen-bob{from{transform:translateY(1px) scale(.92)}to{transform:translateY(-2px) scale(1.08)}}';
fs.writeFileSync(path,css);
console.log('Patched citizen render layer and walking animation');
