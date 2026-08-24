const SAVE_KEY = 'clickGameSave';
const COST_SCALE = 1.15;

// Template: add new upgrades here. Each needs a unique id, name, description,
// starting cost, and an effect of type 'cps' (points per second) or
// 'clickPower' (points added per click).
const upgrades = [
  {
    id: 'cursor',
    name: 'Cursor',
    description: 'Auto-clicks for you.',
    baseCost: 15,
    effect: { type: 'cps', amount: 0.1 },
    count: 0,
  },
  {
    id: 'grandma',
    name: 'Grandma',
    description: 'A friendly grandma to click for you.',
    baseCost: 100,
    effect: { type: 'cps', amount: 1 },
    count: 0,
  },
  {
    id: 'strongerClick',
    name: 'Stronger Finger',
    description: 'Increases points earned per click.',
    baseCost: 50,
    effect: { type: 'clickPower', amount: 1 },
    count: 0,
  },
];

let points = 0;
let clickPower = 1;
let cps = 0;

const scoreDisplay = document.getElementById('score');
const cpsDisplay = document.getElementById('cps');
const clickButton = document.getElementById('clickButton');
const shopList = document.getElementById('shopList');

function costFor(upgrade) {
  return Math.ceil(upgrade.baseCost * Math.pow(COST_SCALE, upgrade.count));
}

function recalcStats() {
  clickPower = 1;
  cps = 0;
  for (const upgrade of upgrades) {
    if (upgrade.effect.type === 'cps') {
      cps += upgrade.effect.amount * upgrade.count;
    } else if (upgrade.effect.type === 'clickPower') {
      clickPower += upgrade.effect.amount * upgrade.count;
    }
  }
}

function formatNumber(num) {
  return Number(num.toFixed(1)).toLocaleString();
}

function updateDisplay() {
  scoreDisplay.textContent = `${formatNumber(points)} points`;
  cpsDisplay.textContent = `${formatNumber(cps)} points/sec`;
  renderShop();
}

function renderShop() {
  shopList.innerHTML = '';
  for (const upgrade of upgrades) {
    const cost = costFor(upgrade);
    const item = document.createElement('button');
    item.className = 'shop-item';
    item.disabled = points < cost;
    item.innerHTML = `
      <div class="shop-item-top">
        <span>${upgrade.name}</span>
        <span>${formatNumber(cost)} pts</span>
      </div>
      <div class="shop-item-desc">${upgrade.description}</div>
      <div class="shop-item-count">Owned: ${upgrade.count}</div>
    `;
    item.addEventListener('click', () => buyUpgrade(upgrade.id));
    shopList.appendChild(item);
  }
}

function buyUpgrade(id) {
  const upgrade = upgrades.find((u) => u.id === id);
  const cost = costFor(upgrade);
  if (points < cost) return;
  points -= cost;
  upgrade.count += 1;
  recalcStats();
  updateDisplay();
  save();
}

function save() {
  const data = {
    points,
    upgrades: Object.fromEntries(upgrades.map((u) => [u.id, u.count])),
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

function load() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    points = data.points || 0;
    for (const upgrade of upgrades) {
      upgrade.count = (data.upgrades && data.upgrades[upgrade.id]) || 0;
    }
  } catch (e) {
    console.error('Failed to load save data', e);
  }
}

clickButton.addEventListener('click', () => {
  points += clickPower;
  updateDisplay();
  save();
});

setInterval(() => {
  if (cps > 0) {
    points += cps / 10;
    updateDisplay();
  }
}, 100);

setInterval(save, 10000);

load();
recalcStats();
updateDisplay();
