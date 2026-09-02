/**
 * Dynamically computes and displays the sum of rubric evaluation marks in real time
 * with input bounds enforcement (0 to max) and visual validation states.
 */
function initEvalCalc() {
  var form = document.getElementById('evalForm');
  if (!form) return;
  var inputs = form.querySelectorAll('.mark');
  var totalEl = document.getElementById('tot');

  function calculate() {
    var total = 0;
    inputs.forEach(function (input) {
      var max = parseInt(input.getAttribute('max'), 10) || 10;
      var min = parseInt(input.getAttribute('min'), 10) || 0;
      var val = parseInt(input.value, 10);

      if (isNaN(val)) {
        input.classList.remove('is-invalid');
      } else if (val < min || val > max) {
        input.classList.add('is-invalid');
      } else {
        input.classList.remove('is-invalid');
        total += val;
      }
    });
    if (totalEl) totalEl.textContent = total;
  }

  inputs.forEach(function (input) {
    input.addEventListener('input', calculate);
    input.addEventListener('change', calculate);
    input.addEventListener('blur', function () {
      var max = parseInt(input.getAttribute('max'), 10) || 10;
      var min = parseInt(input.getAttribute('min'), 10) || 0;
      var val = parseInt(input.value, 10);
      if (!isNaN(val)) {
        if (val > max) input.value = max;
        if (val < min) input.value = min;
        calculate();
      }
    });
  });
  calculate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEvalCalc);
} else {
  initEvalCalc();
}

