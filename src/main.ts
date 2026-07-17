import './style.css';

const app = document.querySelector<HTMLElement>('#app');

if (!app) throw new Error('app-root-missing');

const heading = document.createElement('h1');
heading.textContent = '文豪ずんだもん';
const note = document.createElement('p');
note.textContent = '設計フェーズを開始しました。';
app.replaceChildren(heading, note);
