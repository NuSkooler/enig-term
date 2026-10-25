// GLSL ES 3.00 shaders for the output pass.
//
// The CRT functions (adjust_color, apply_curvature, apply_scanlines, rand,
// apply_noise, apply_sync_wobble, apply_bloom and the monitor tint) are ported
// from icy_tools' crates/icy_engine_gui/src/terminal/crt_shader.wgsl
// (Copyright (c) Mike Krueger, MIT OR Apache-2.0; see NOTICE). The editor
// overlays (selection, layers, reference image, raster/guide, brush preview,
// texture slicing) are not ported. Differences from icy:
//   * one plain sampler2D instead of a sliced texture array;
//   * scanlines are one beam profile per source row (the CRT's own lines)
//     rather than icy's every-other-output-pixel pattern, so they survive
//     high-DPI scaling;
//   * sharp-bilinear sampling and the cursor are ours.

export const VERT = `#version 300 es
out vec2 v_uv;
void main() {
    // Full-viewport triangle; uv is 0..1 with y pointing down the frame.
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_uv = vec2(p.x, 1.0 - p.y);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_color;

uniform sampler2D u_tex;
uniform vec2 u_src;          // frame size in source pixels
uniform vec2 u_dst;          // drawn size in device pixels
uniform float u_sharp;       // 1 = sharp-bilinear, 0 = plain bilinear
uniform vec4 u_cursor;       // x, y, w, h in source pixels; w <= 0 hides it
uniform vec4 u_sel;          // selection x0, y0, x1, y1 in cells (x1 inclusive); x0 < 0 = none
uniform vec2 u_cell;         // cell size in source pixels
uniform float u_time;

uniform float u_crt;         // master switch for everything below
uniform float u_brightness, u_contrast, u_gamma, u_saturation, u_monitor_type;
uniform vec3 u_monitor_tint;
uniform float u_enable_curvature, u_curvature_x, u_curvature_y;
uniform float u_enable_scanlines, u_scanline_thickness, u_scanline_sharpness, u_scanline_phase;
uniform float u_enable_noise, u_noise_level, u_sync_wobble;
uniform float u_enable_bloom, u_bloom_threshold, u_bloom_radius, u_bloom_intensity;

// --- sharp-bilinear -------------------------------------------------------
// Each texel is drawn flat, with a blended edge exactly one device pixel wide,
// so any non-integer scale (4:3 needs one) stays crisp without uneven
// nearest-neighbour columns. Same math as icy's sharpen_texel: the scale is the
// real device-pixels-per-texel, not its floor (flooring degenerates to plain
// bilinear below 2x).
vec4 sample_frame(vec2 uv) {
    if (u_sharp < 0.5) return texture(u_tex, uv);
    vec2 texel = uv * u_src;
    vec2 scale = max(u_dst / u_src, vec2(1.0));
    vec2 base = floor(texel);
    vec2 center = fract(texel) - 0.5;
    vec2 range = 0.5 - 0.5 / scale;
    vec2 f = (center - clamp(center, -range, range)) * scale + 0.5;
    return texture(u_tex, (base + f) / u_src);
}

// --- ported from icy crt_shader.wgsl -------------------------------------
vec3 adjust_color(vec3 base) {
    vec3 color = base;
    float g = u_gamma;
    if (g > 0.0001 && abs(g - 1.0) > 0.00001) color = pow(color, vec3(1.0 / g));
    if (abs(u_brightness - 1.0) > 0.00001) color = color * u_brightness;
    if (abs(u_contrast - 1.0) > 0.00001) color = (color - vec3(0.5)) * u_contrast + vec3(0.5);
    if (u_monitor_type < 0.5 && abs(u_saturation - 1.0) > 0.00001) {
        float gray = dot(color, vec3(0.299, 0.587, 0.114));
        color = mix(vec3(gray), color, u_saturation);
    }
    return color;
}

vec2 apply_curvature(vec2 uv_in) {
    if (u_enable_curvature < 0.5) return uv_in;
    vec2 uv = uv_in * 2.0 - 1.0;
    vec2 offset = abs(uv.yx) / vec2(u_curvature_x, u_curvature_y);
    uv = uv + uv * offset * offset;
    return uv * 0.5 + 0.5;
}

vec3 apply_scanlines(vec3 color_in, vec2 tex_coord) {
    if (u_enable_scanlines < 0.5) return color_in;
    // Deviation from icy (which darkens every other OUTPUT row): one beam per
    // SOURCE row, brightest at its centre and darkened toward the gap between
    // rows. Survives DPR changes and does not alias into moire under curvature
    // as badly as two lines per row did.
    float fr = fract(tex_coord.y * u_src.y + u_scanline_phase);
    float d = abs(fr - 0.5) * 2.0; // 0 at beam centre, 1 at the row gap
    float min_mul = mix(0.9, 0.3, u_scanline_thickness);
    float edge = smoothstep(mix(0.2, 0.7, u_scanline_sharpness), 1.0, d);
    return color_in * mix(1.0, min_mul, edge);
}

float rand(vec2 p) {
    float h = dot(p + u_time * 0.37, vec2(12.9898, 78.233));
    return fract(sin(h) * 43758.5453);
}

vec3 apply_noise(vec3 color_in, vec2 uv) {
    if (u_enable_noise < 0.5 || u_noise_level <= 0.00001) return color_in;
    float n1 = rand(uv * 1.0);
    float n2 = rand(uv * 7.13 + vec2(u_time * 0.11, u_time * 0.07));
    float n = (n1 + n2) * 0.5;
    float grain = (n - 0.5) * 2.0;
    float luma = dot(color_in, vec3(0.299, 0.587, 0.114));
    float attenuation = mix(0.6, 1.0, luma);
    float strength = u_noise_level * 1.2 * attenuation;
    return clamp(color_in + grain * strength * 0.15, vec3(0.0), vec3(1.0));
}

vec2 apply_sync_wobble(vec2 uv) {
    if (u_enable_noise < 0.5 || u_noise_level <= 0.00001) return uv;
    float distort_amount = sin(uv.y * 5.0 + u_time * 3.5) * 0.5 + 0.5;
    float noise = rand(vec2(uv.y * 10.0, u_time)) - 0.5;
    return vec2(uv.x + (distort_amount * noise) * u_sync_wobble * 0.02, uv.y);
}

vec3 apply_bloom(vec2 uv) {
    if (u_enable_bloom < 0.5 || u_bloom_intensity <= 0.001) return vec3(0.0);
    float radius = max(u_bloom_radius, 0.5);
    vec2 px = radius / u_dst;
    vec3 glow = vec3(0.0);
    float total_weight = 0.0;
    for (float dy = -2.0; dy <= 2.0; dy += 1.0) {
        for (float dx = -2.0; dx <= 2.0; dx += 1.0) {
            vec2 suv = clamp(uv + vec2(dx, dy) * px, vec2(0.0), vec2(1.0));
            vec3 sc = adjust_color(texture(u_tex, suv).rgb);
            float sl = dot(sc, vec3(0.299, 0.587, 0.114));
            float dist = length(vec2(dx, dy));
            float weight = exp(-dist * dist * 0.3);
            float tb = smoothstep(u_bloom_threshold - 0.1, u_bloom_threshold, sl);
            glow += sc * tb * weight;
            total_weight += weight * tb;
        }
    }
    if (total_weight > 0.001) return glow / total_weight * u_bloom_intensity * 1.5;
    return vec3(0.0);
}

vec3 monitor(vec3 color) {
    if (u_monitor_type < 0.5) return color;
    float gray = dot(color, vec3(0.299, 0.587, 0.114));
    if (u_monitor_type < 1.5) return vec3(gray);
    vec3 tint = u_monitor_tint;
    float max_comp = max(tint.r, max(tint.g, tint.b));
    vec3 norm_tint = max_comp > 0.0001 ? tint / max_comp : vec3(1.0);
    vec3 mono = gray * norm_tint * 1.5 + norm_tint * 0.05;
    mono = mono / (mono + vec3(1.0)) * 2.0;
    return clamp(mono, vec3(0.0), vec3(1.0));
}
// --- end of ported functions ---------------------------------------------

bool selected(vec2 p) {
    if (u_sel.x < 0.0) return false;
    vec2 c = floor(p / u_cell);
    if (c.y < u_sel.y || c.y > u_sel.w) return false;
    if (u_sel.y == u_sel.w) return c.x >= u_sel.x && c.x <= u_sel.z;
    if (c.y == u_sel.y) return c.x >= u_sel.x;
    if (c.y == u_sel.w) return c.x <= u_sel.z;
    return true;
}

// Cursor and selection both invert; over each other they cancel, as on a PC.
vec3 with_overlays(vec3 color, vec2 uv) {
    vec2 p = floor(uv * u_src);
    bool inv = selected(p);
    if (u_cursor.z > 0.0 && p.x >= u_cursor.x && p.x < u_cursor.x + u_cursor.z && p.y >= u_cursor.y && p.y < u_cursor.y + u_cursor.w) inv = !inv;
    return inv ? vec3(1.0) - color : color;
}

void main() {
    vec2 uv = v_uv;
    if (u_crt < 0.5) {
        vec4 t = sample_frame(uv);
        o_color = vec4(with_overlays(t.rgb, uv), 1.0);
        return;
    }
    uv = apply_curvature(apply_sync_wobble(uv));
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
        o_color = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    vec3 color = adjust_color(with_overlays(sample_frame(uv).rgb, uv));
    vec3 bloom = apply_bloom(uv);
    color = apply_scanlines(color, uv);
    color = apply_noise(color, uv);
    color = clamp(color + bloom, vec3(0.0), vec3(1.0));
    o_color = vec4(monitor(color), 1.0);
}
`;

export interface CrtSettings {
    brightness: number; // 1.0 neutral
    contrast: number;
    gamma: number;
    saturation: number;
    monitor: 'color' | 'gray' | 'amber' | 'green';
    curvature: boolean;
    curvatureX: number; // icy slider 0..100 (60 default)
    curvatureY: number;
    scanlines: boolean;
    scanlineThickness: number; // 0..1
    scanlineSharpness: number;
    noise: boolean;
    noiseLevel: number; // 0..100
    syncWobble: number; // 0..100
    bloom: boolean;
    bloomThreshold: number; // 0..100
    bloomRadius: number; // icy units (/10)
    glowStrength: number; // icy units (/50)
}

/**
 * Curvature + scanlines. icy's own defaults turn every effect off. Bloom is
 * available but off: icy's bloom divides by the *thresholded* weight sum, so a
 * single bright neighbour gives a full-strength glow and dense text gets a grey
 * halo box (seen in the spike screenshots).
 */
export const CRT_DEFAULTS: CrtSettings = {
    brightness: 1.05,
    contrast: 1.05,
    gamma: 1.0,
    saturation: 1.0,
    monitor: 'color',
    curvature: true,
    curvatureX: 60,
    curvatureY: 60,
    scanlines: true,
    scanlineThickness: 0.5,
    scanlineSharpness: 0.5,
    noise: false,
    noiseLevel: 20,
    syncWobble: 20,
    bloom: false,
    bloomThreshold: 25,
    bloomRadius: 30,
    glowStrength: 15,
};

export const MONITOR_TINTS: Record<CrtSettings['monitor'], [number, number, number]> = {
    color: [0, 0, 0],
    gray: [1, 1, 1],
    amber: [0xff / 255, 0x81 / 255, 0],
    green: [0x0c / 255, 0xcc / 255, 0x68 / 255],
};
