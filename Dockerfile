# The perch binary in a container, for running an object on a server:
#
#   docker build -t perch .
#   docker run -p 8787:8787 -v "$PWD":/data perch run /data/my.perch --host 0.0.0.0
#
# V8 arrives prebuilt through deno_core (the v8 crate downloads the static
# library for the target), so this is an ordinary cargo build.
FROM rust:1.97-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY js js
RUN cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=build /src/target/release/perch /usr/local/bin/perch
# Objects live on a mounted volume; perch needs nothing else from the image.
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/perch"]
