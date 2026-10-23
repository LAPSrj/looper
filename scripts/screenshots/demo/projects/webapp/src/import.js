exports.fromStream = async (stream) => { for await (const chunk of stream) void chunk; };
