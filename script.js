let points = 0;
const scoreDisplay = document.getElementById('score');
const clickButton = document.getElementById('clickButton');

clickButton.addEventListener('click', () => {
  points += 1;
  scoreDisplay.textContent = `Points: ${points}`;
});
