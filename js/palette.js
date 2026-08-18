window.Monetra = window.Monetra || {};

/* Light-theme palette tokens, fixed categorical order — never cycled or
   re-ordered per chart. See dataviz reference palette for provenance. */
Monetra.palette = {
  categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  income: '#2a78d6',
  expense: '#e34948',
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
  grid: '#e1e0d9',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  categoryColor(index) {
    return this.categorical[index % this.categorical.length];
  }
};
