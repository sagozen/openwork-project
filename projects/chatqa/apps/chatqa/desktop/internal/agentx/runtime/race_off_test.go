//go:build !race

package runtime

// raceDetector is true when the tests run under -race.
const raceDetector = false
