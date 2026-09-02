/**
 * Konfident Interview 2025 — Landing Page Hero Animations
 * Powered by Anime.js — Smooth 60fps / 120fps fluid orchestrations
 */
(function () {
  'use strict';

  function initLandingAnimations() {
    if (typeof anime === 'undefined') {
      console.warn('[Landing] Anime.js not loaded. Falling back gracefully.');
      return;
    }

    // Unified animation runner supporting both Anime.js v3 (anime({...})) and v4 (anime.animate({...}) / anime({...}))
    function runAnime(params) {
      try {
        if (typeof anime === 'function') {
          return anime(params);
        } else if (anime && typeof anime.animate === 'function') {
          const targets = params.targets;
          const opts = { ...params };
          delete opts.targets;
          return anime.animate(targets, opts);
        }
      } catch (err) {
        console.debug('[Anime Error]', err);
      }
    }

    // 1. Smooth Staggered Typography Entrance
    runAnime({
      targets: '.hero-animate-in',
      translateY: [20, 0],
      opacity: [0, 1],
      delay: (el, i) => 80 * i,
      duration: 700,
      easing: 'easeOutCubic',
    });

    // 2. Scorecard Visual Cards Gentle Entrance
    runAnime({
      targets: '.hero-card-float',
      translateY: [24, 0],
      opacity: [0, 1],
      delay: (el, i) => 150 + (i * 120),
      duration: 800,
      easing: 'easeOutCubic',
    });

    // 3. Smooth Continuous Floating Physics (No jarring callback transitions)
    runAnime({
      targets: '.hero-card-primary',
      translateY: [-5, 5],
      duration: 4000,
      direction: 'alternate',
      loop: true,
      easing: 'easeInOutSine',
    });

    runAnime({
      targets: '.hero-card-badge-top',
      translateY: [-4, 4],
      duration: 3400,
      direction: 'alternate',
      loop: true,
      easing: 'easeInOutSine',
      delay: 300,
    });

    runAnime({
      targets: '.hero-card-badge-bottom',
      translateY: [4, -4],
      duration: 3800,
      direction: 'alternate',
      loop: true,
      easing: 'easeInOutSine',
      delay: 600,
    });

    // 4. Rubric Criterion Progress Bars Fill Animation
    const bars = document.querySelectorAll('.rubric-progress-fill');
    bars.forEach((bar, index) => {
      const targetWidth = bar.getAttribute('data-width') || '100%';
      runAnime({
        targets: bar,
        width: ['0%', targetWidth],
        duration: 1100,
        delay: 400 + (index * 160),
        easing: 'easeOutQuart',
      });
    });

    // 5. Live Score Ticker Animation (0 -> 28)
    const scoreEl = document.getElementById('heroLiveScore');
    if (scoreEl) {
      const scoreObj = { val: 0 };
      runAnime({
        targets: scoreObj,
        val: [0, 28],
        round: 1,
        duration: 1400,
        delay: 500,
        easing: 'easeOutCubic',
        update: function () {
          scoreEl.textContent = Math.round(scoreObj.val);
        }
      });
    }

    // 6. Connecting Pipeline Pulse Animation
    runAnime({
      targets: '.pipeline-pulse',
      strokeDashoffset: [160, 0],
      duration: 2600,
      delay: (el, i) => i * 300,
      loop: true,
      easing: 'linear',
    });

    runAnime({
      targets: '.pulse-dot',
      scale: [0.9, 1.25],
      opacity: [0.7, 1],
      duration: 1200,
      direction: 'alternate',
      loop: true,
      easing: 'easeInOutSine',
    });

    // 7. Ambient Geometric Floating Particles
    const bgDots = document.querySelectorAll('.ambient-particle');
    if (bgDots.length > 0) {
      runAnime({
        targets: bgDots,
        translateY: function () { return (Math.random() * 24) - 12; },
        translateX: function () { return (Math.random() * 16) - 8; },
        scale: function () { return 0.85 + Math.random() * 0.3; },
        opacity: function () { return 0.25 + Math.random() * 0.35; },
        duration: function () { return 3500 + Math.random() * 2500; },
        direction: 'alternate',
        loop: true,
        easing: 'easeInOutSine',
      });
    }

    // 8. Card Hover Effects
    const interactiveCards = document.querySelectorAll('.landing-feature-card, .landing-why-card');
    interactiveCards.forEach(card => {
      card.addEventListener('mouseenter', () => {
        runAnime({
          targets: card,
          translateY: -4,
          duration: 200,
          easing: 'easeOutQuad',
        });
      });
      card.addEventListener('mouseleave', () => {
        runAnime({
          targets: card,
          translateY: 0,
          duration: 250,
          easing: 'easeOutQuad',
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLandingAnimations);
  } else {
    initLandingAnimations();
  }
})();
