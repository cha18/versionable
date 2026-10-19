use std::fs;
use std::path::Path;
use versionable_core::{diff::diff, parse::parse_als};

#[test]
fn golden() {
    let fixtures_dir = Path::new("../fixtures");
    for entry in fs::read_dir(fixtures_dir).unwrap().flatten() {
        let song_dir = entry.path();
        if !song_dir.is_dir() {
            continue;
        }
        let mut files: Vec<_> = fs::read_dir(&song_dir)
            .unwrap()
            .flatten()
            .map(|f| f.path())
            .filter(|p| p.extension().map_or(false, |ext| ext == "als"))
            .collect();
        files.sort();

        for pair in files.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);

            let d = diff(&parse_als(a).unwrap(), &parse_als(b).unwrap());
            let actual = serde_json::to_value(&d).unwrap();

            let a_stem = a.file_stem().unwrap().to_str().unwrap();
            let b_stem = b.file_stem().unwrap().to_str().unwrap();
            let expected_json = song_dir
                .join("expected")
                .join(format!("{}__{}.json", a_stem, b_stem));
            let expected: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&expected_json).unwrap()).unwrap();

            pretty_assertions::assert_eq!(actual, expected)
        }
    }
}
