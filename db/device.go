package db

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

// DeviceToken is one enrollment token for a mobile device agent. Only the hash is
// stored: a leaked database must not hand out working device credentials.
type DeviceToken struct {
	ID         int64      `json:"id"`
	Label      string     `json:"label"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
	Revoked    bool       `json:"revoked"`
}

// HashDeviceToken turns a bearer token into its stored form.
func HashDeviceToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// CreateDeviceToken mints a token, stores its hash, and returns the plaintext
// exactly once (the caller hands it to the device operator).
func (d *DB) CreateDeviceToken(label string) (string, *DeviceToken, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, err
	}
	token := hex.EncodeToString(buf)
	hash := HashDeviceToken(token)
	prefix := token[:8]
	var t DeviceToken
	err := d.QueryRow(`
INSERT INTO device_tokens(token_hash, label, prefix) VALUES ($1, $2, $3)
RETURNING id, label, prefix, created_at, last_seen_at, revoked`,
		hash, label, prefix).Scan(&t.ID, &t.Label, &t.Prefix, &t.CreatedAt, &t.LastSeenAt, &t.Revoked)
	if err != nil {
		return "", nil, err
	}
	return token, &t, nil
}

// ListDeviceTokens returns all enrollment tokens, newest first (never the hash).
func (d *DB) ListDeviceTokens() ([]DeviceToken, error) {
	rows, err := d.Query(`SELECT id, label, prefix, created_at, last_seen_at, revoked FROM device_tokens ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeviceToken
	for rows.Next() {
		var t DeviceToken
		if err := rows.Scan(&t.ID, &t.Label, &t.Prefix, &t.CreatedAt, &t.LastSeenAt, &t.Revoked); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// RevokeDeviceToken marks a token unusable (existing connections are not killed
// here; the hub drops them on the next reconnect attempt).
func (d *DB) RevokeDeviceToken(id int64) error {
	_, err := d.Exec(`UPDATE device_tokens SET revoked=true WHERE id=$1`, id)
	return err
}

// TouchDeviceToken records a successful connect for one token hash.
func (d *DB) TouchDeviceToken(hash string) error {
	_, err := d.Exec(`UPDATE device_tokens SET last_seen_at=now() WHERE token_hash=$1`, hash)
	return err
}

// VerifyDeviceToken reports whether a plaintext token is valid and not revoked.
func (d *DB) VerifyDeviceToken(token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	var revoked bool
	err := d.QueryRow(`SELECT revoked FROM device_tokens WHERE token_hash=$1`, HashDeviceToken(token)).Scan(&revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !revoked, nil
}