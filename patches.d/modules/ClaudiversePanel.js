// Claudiverse Right Panel
// Replaces the right side of the LogoV2 component.
// Initially passes through to the original feed panel — customize here.
//
// Receives:
//   createElement  — React.createElement
//   FeedPanel      — the original $P7 component
//   props          — { feeds, maxWidth }

var __claudiversePanel = (function () {
    function render(createElement, FeedPanel, props) {
        // Initially: replicate original behaviour
        return createElement(FeedPanel, props);
    }

    return { render };
})();
