// Demo media from our coauthor's project presentation:
// https://zelongxueric.github.io/media/cua-swe-demo.mp4
(() => {
  const videos = document.querySelectorAll('.paper-video');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!('IntersectionObserver' in window)) return;

  const visible = new Set();
  const sync = () => {
    videos.forEach(video => {
      if (visible.has(video) && !document.hidden && !reducedMotion.matches) {
        video.play().catch(() => { /* Native controls allow manual playback. */ });
      } else {
        video.pause();
      }
    });
  };
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.4) {
        visible.add(entry.target);
      } else {
        visible.delete(entry.target);
      }
    });
    sync();
  }, { threshold: [0, 0.4] });
  videos.forEach(video => observer.observe(video));
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
})();
