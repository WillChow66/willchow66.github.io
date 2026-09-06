-- Empty aggregates: no sample visitors or event-level data.
CREATE TABLE IF NOT EXISTS totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  views INTEGER NOT NULL CHECK (views >= 0 AND views <= 9007199254740991)
);

CREATE TABLE IF NOT EXISTS points (
  country TEXT NOT NULL CHECK (length(country) = 2),
  city TEXT NOT NULL CHECK (length(city) <= 80),
  lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
  views INTEGER NOT NULL CHECK (views >= 0 AND views <= 9007199254740991),
  PRIMARY KEY (country, city, lat, lon)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS points_by_views
  ON points (views DESC, country, city, lat, lon);
