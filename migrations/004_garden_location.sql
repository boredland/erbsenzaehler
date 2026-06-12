-- Optional garden location for rain-aware watering cadence.
ALTER TABLE gardens ADD COLUMN lat REAL;
ALTER TABLE gardens ADD COLUMN lon REAL;
ALTER TABLE gardens ADD COLUMN location_label TEXT;
