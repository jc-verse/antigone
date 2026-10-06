FROM runpod/comfyui:cuda13.0@sha256:bad26aad809a442a0d2674827d58c03f95686d0ea6d0d0e0cbebacd787488797

COPY --chmod=755 prepare.py /usr/local/bin/antigone-prepare
RUN antigone-prepare

EXPOSE 8188
ENTRYPOINT ["/start.sh"]
CMD []
