/**
 * Dynamically computes and displays the sum of rubric evaluation marks in real time.
 */
document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('evalForm');
  if (!form) return;
  var inputs = form.querySelectorAll('.mark');
  var totalEl = document.getElementById('tot');

  function calculate() {
    var total = 0;
    inputs.forEach(function (input) {
      var val = parseInt(input.value, 10);
      if (!isNaN(val)) total += val;
    });
    if (totalEl) totalEl.textContent = total;
  }

  inputs.forEach(function (input) {
    input.addEventListener('input', calculate);
  });
  calculate();
});
