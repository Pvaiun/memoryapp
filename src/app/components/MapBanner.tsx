// What's going on with today's map whenever it's anything other than "here it
// is". It sits under the header on every tab, so a failure can't be missed by
// happening to look at the calendar instead of the Now view, and it stays up
// until the problem is gone — no full-screen wait, and no toast that fades.

export default function MapBanner({
  building,
  hasMap,
  loadError,
  buildError,
  onRetryLoad,
  onRebuild,
  onDismissBuildError,
}: {
  building: boolean;
  hasMap: boolean;
  loadError: string | null; // the map request itself failed
  buildError: string | null; // the Brain failed; the map shown is the fallback
  onRetryLoad: () => void;
  onRebuild: () => void;
  onDismissBuildError: () => void;
}) {
  if (loadError) {
    return (
      <div className="map-banner error" role="alert">
        <div className="map-banner-text">
          <strong>{hasMap ? 'Couldn’t refresh today’s map' : 'Today’s map didn’t load'}</strong>
          <span>
            {hasMap ? 'Showing the copy saved on this device. ' : ''}
            {loadError}
          </span>
        </div>
        <button className="map-banner-action" onClick={onRetryLoad}>
          Retry
        </button>
      </div>
    );
  }

  if (building) {
    return (
      <div className="map-banner" role="status">
        <span className="map-banner-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <div className="map-banner-text">
          <strong>{hasMap ? 'Rebuilding today’s map…' : 'Building today’s map…'}</strong>
        </div>
      </div>
    );
  }

  if (buildError) {
    return (
      <div className="map-banner warn" role="alert">
        <div className="map-banner-text">
          <strong>Today’s map is a basic fallback</strong>
          <span>The Brain couldn’t build it: {buildError}.</span>
        </div>
        <button className="map-banner-action" onClick={onRebuild}>
          Try again
        </button>
        <button className="map-banner-dismiss" aria-label="Dismiss" onClick={onDismissBuildError}>
          ×
        </button>
      </div>
    );
  }

  return null;
}
