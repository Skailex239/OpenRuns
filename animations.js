/* ============================================
   OpenRuns — Animation Engine
   Scroll reveals, count-up, particles, ripples
   ============================================ */

(function () {
  'use strict';

  /* ── 1. Floating Particles ── */
  function initParticles() {
    var canvas = document.createElement('canvas');
    canvas.className = 'particles-canvas';
    document.body.prepend(canvas);

    var ctx = canvas.getContext('2d');
    var particles = [];
    var PARTICLE_COUNT = 35;
    var mouse = { x: -1000, y: -1000 };

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Track mouse for subtle interaction
    document.addEventListener('mousemove', function (e) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    });

    // Create particles
    for (var i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 2 + 0.5,
        opacity: Math.random() * 0.3 + 0.1
      });
    }

    function drawParticles() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];

        // Move
        p.x += p.vx;
        p.y += p.vy;

        // Subtle mouse repulsion
        var dx = p.x - mouse.x;
        var dy = p.y - mouse.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          p.vx += dx / dist * 0.02;
          p.vy += dy / dist * 0.02;
        }

        // Damping
        p.vx *= 0.99;
        p.vy *= 0.99;

        // Wrap
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        // Draw
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(91,138,255,' + p.opacity + ')';
        ctx.fill();

        // Draw connections
        for (var j = i + 1; j < particles.length; j++) {
          var p2 = particles[j];
          var d = Math.sqrt((p.x - p2.x) ** 2 + (p.y - p2.y) ** 2);
          if (d < 150) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = 'rgba(91,138,255,' + (0.06 * (1 - d / 150)) + ')';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(drawParticles);
    }
    drawParticles();
  }

  /* ── 2. Scroll Reveal via IntersectionObserver ── */
  function initScrollReveal() {
    var reveals = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');
    if (!reveals.length) return;

    // Add reveal classes to key elements automatically
    var autoReveal = [
      { selector: '.hero-stats .stat-card', cls: 'reveal', stagger: true },
      { selector: '.feed-card', cls: 'reveal' },
      { selector: '.hof-card', cls: 'reveal', stagger: true },
      { selector: '.chart-card', cls: 'reveal', stagger: true },
      { selector: '.profile-stats-grid .modal-stat', cls: 'reveal', stagger: true },
      { selector: '.profile-charts-grid .feed-card', cls: 'reveal', stagger: true },
      { selector: '.profile-sections-grid .feed-card', cls: 'reveal', stagger: true },
      { selector: '.sidebar', cls: 'reveal-left' },
      { selector: '.content', cls: 'reveal-right' }
    ];

    autoReveal.forEach(function (rule) {
      var els = document.querySelectorAll(rule.selector);
      els.forEach(function (el, i) {
        if (!el.classList.contains('reveal') && !el.classList.contains('reveal-left') && !el.classList.contains('reveal-right')) {
          el.classList.add(rule.cls);
          if (rule.stagger) {
            el.style.transitionDelay = (i * 0.07) + 's';
          }
        }
      });
    });

    // Refresh the list after auto-adding
    reveals = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -40px 0px'
    });

    reveals.forEach(function (el) {
      observer.observe(el);
    });
  }

  /* ── 3. Number Count-Up Animation ── */
  function animateCountUp(el) {
    var target = parseInt(el.getAttribute('data-count') || el.textContent.replace(/[^\d]/g, ''), 10);
    if (isNaN(target) || target === 0) return;

    var duration = 1200;
    var start = performance.now();
    el.classList.add('counting');

    function tick(now) {
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      var ease = 1 - Math.pow(1 - progress, 3);
      var current = Math.floor(ease * target);

      // Format with commas for large numbers
      el.textContent = current.toLocaleString('fr-FR');

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        el.textContent = target.toLocaleString('fr-FR');
        el.classList.remove('counting');
        el.classList.add('count-pop');
      }
    }
    requestAnimationFrame(tick);
  }

  function initCountUp() {
    var statValues = document.querySelectorAll('.stat-value');
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !entry.target.classList.contains('counted')) {
          entry.target.classList.add('counted');
          animateCountUp(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    statValues.forEach(function (el) {
      // Only animate if it has a number
      var val = el.textContent.replace(/[^\d]/g, '');
      if (val && parseInt(val, 10) > 0) {
        el.setAttribute('data-count', val);
        observer.observe(el);
      }
    });
  }

  /* ── 4. Ripple Effect on Buttons ── */
  function initRipple() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.login-btn, .auth-btn, .share-btn, .see-more-btn, .settings-action-btn, .profile-edit-btn, .tab-btn, .runs-btn, .gg-btn');
      if (!btn) return;

      btn.classList.add('ripple');
      var rect = btn.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var size = Math.max(rect.width, rect.height) * 2;

      var wave = document.createElement('span');
      wave.className = 'ripple-wave';
      wave.style.width = wave.style.height = size + 'px';
      wave.style.left = (x - size / 2) + 'px';
      wave.style.top = (y - size / 2) + 'px';

      btn.appendChild(wave);
      wave.addEventListener('animationend', function () {
        wave.remove();
      });
    });
  }

  /* ── 5. Staggered Page Entrance ── */
  function initPageEntrance() {
    var elements = [
      { sel: '.site-logo', delay: 0 },
      { sel: '.nav .header-right', delay: 1 },
      { sel: '.hero-stats', delay: 2 },
      { sel: '.tabs', delay: 3 },
      { sel: '.search-bar', delay: 4 },
      { sel: '.main-grid', delay: 5 },
      { sel: '.profile-page-header', delay: 0 },
      { sel: '#profile-loading, #profile-gate, #profile-setup, #profile-main', delay: 2 }
    ];

    elements.forEach(function (rule) {
      var el = document.querySelector(rule.sel);
      if (el && !el.classList.contains('animate-entrance')) {
        el.classList.add('animate-entrance');
        el.classList.add('stagger-' + rule.delay);
      }
    });
  }

  /* ── 6. Shimmer on Loading States ── */
  function initShimmer() {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('loading')) {
            node.classList.add('shimmer');
          }
          var loadings = node.querySelectorAll ? node.querySelectorAll('.loading') : [];
          loadings.forEach(function (el) {
            el.classList.add('shimmer');
          });
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also apply to existing loading elements
    document.querySelectorAll('.loading').forEach(function (el) {
      el.classList.add('shimmer');
    });
  }

  /* ── 7. 3D Tilt on Cards ── */
  function init3DTilt() {
    var tiltTargets = '.stat-card, .hof-card';
    var MAX_TILT = 6;

    document.addEventListener('mousemove', function (e) {
      var cards = document.querySelectorAll(tiltTargets);
      cards.forEach(function (card) {
        var rect = card.getBoundingClientRect();
        // Only apply tilt if mouse is near the card
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var dist = Math.sqrt((e.clientX - cx) ** 2 + (e.clientY - cy) ** 2);
        if (dist > 400) {
          card.style.transform = '';
          return;
        }

        var x = (e.clientX - rect.left) / rect.width - 0.5;
        var y = (e.clientY - rect.top) / rect.height - 0.5;
        var rotY = x * MAX_TILT;
        var rotX = -y * MAX_TILT;

        // Only on hover (mouse is inside the card)
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          card.style.transform = 'perspective(600px) rotateX(' + rotX + 'deg) rotateY(' + rotY + 'deg) translateY(-4px)';
        } else {
          card.style.transform = '';
        }
      });
    });

    document.addEventListener('mouseleave', function () {
      document.querySelectorAll(tiltTargets).forEach(function (card) {
        card.style.transform = '';
      });
    });
  }

  /* ── 8. Smooth value updates for live stats ── */
  function initLiveUpdates() {
    // Watch for stat-value changes and add pop animation
    var statEls = document.querySelectorAll('.stat-value');
    statEls.forEach(function (el) {
      var lastVal = el.textContent;
      var observer = new MutationObserver(function () {
        if (el.textContent !== lastVal) {
          lastVal = el.textContent;
          el.classList.remove('count-pop');
          void el.offsetWidth; // reflow
          el.classList.add('count-pop');
        }
      });
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ── Initialize Everything ── */
  function init() {
    initParticles();
    initPageEntrance();
    initScrollReveal();
    initCountUp();
    initRipple();
    initShimmer();
    init3DTilt();
    initLiveUpdates();
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-init scroll reveals after dynamic content loads (delayed)
  setTimeout(function () {
    initScrollReveal();
    initCountUp();
    initShimmer();
  }, 2000);

})();
