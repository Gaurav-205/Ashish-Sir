(function() {
  const buttons = document.querySelectorAll('.demo-role-btn');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');

  if (!buttons.length || !emailInput || !passwordInput) return;

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const email = btn.dataset.email;
      const pass = btn.dataset.password;
      if (!email || !pass) return;

      emailInput.value = email;
      passwordInput.value = pass;

      // Visual feedback
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      emailInput.focus();
    });
  });
})();
