# -*- coding: utf-8 -*-
"""人脈管理 Blueprint 集合。"""

from .people import bp as people_bp
from .roles import bp as roles_bp
from .contacts import bp as contacts_bp
from .groups import bp as groups_bp

__all__ = ["people_bp", "roles_bp", "contacts_bp", "groups_bp"]
